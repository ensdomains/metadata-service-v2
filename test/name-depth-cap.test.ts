import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Mock rasterize to avoid WASM import issues in Vite (mirrors test/index.test.ts).
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { AvatarService } from '../src/services/avatar';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { InvalidNameError, NotFoundError } from '../src/services/errors';
import { validateEnsName, MAX_NAME_LABELS } from '../src/utils/ens';

// WEB-1552: validateEnsName only capped a name's length (255), so a name of up
// to 128 one-character labels passed every name-taking route, and the
// registry-hierarchy blockchain tier resolved each of its levels in turn.
// Names deeper than MAX_NAME_LABELS are now the ordinary invalid-name 400.

// A name with `labels` labels, ending in .eth (well under the 255-char cap).
function deepName(labels: number): string {
  return [...Array.from({ length: labels - 1 }, (_, i) => `l${i}`), 'eth'].join('.');
}

const AT_CAP = deepName(MAX_NAME_LABELS);
const OVER_CAP = deepName(MAX_NAME_LABELS + 1);

describe('validateEnsName label cap', () => {
  it(`accepts ${MAX_NAME_LABELS} labels and rejects ${MAX_NAME_LABELS + 1}`, () => {
    expect(MAX_NAME_LABELS).toBe(32);
    expect(OVER_CAP.length).toBeLessThan(255); // rejected for depth, not length
    expect(validateEnsName(AT_CAP)).toBe(true);
    expect(validateEnsName(OVER_CAP)).toBe(false);
  });
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) =>
  app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

describe('every name-taking route rejects a name over the label cap with 400', () => {
  // Stub the first service call each route makes after validation, so a name
  // that passes validation stops at a stubbed 404 instead of touching the network.
  type Stub = { mock: { calls: unknown[][] } };
  let checkExpiry: Stub;
  let avatarStubs: Stub[];

  beforeEach(() => {
    checkExpiry = vi.spyOn(MetadataService.prototype, 'checkExpiry')
      .mockRejectedValue(new NotFoundError('stub: reached the service', { definitive: true }));
    avatarStubs = [
      vi.spyOn(AvatarService.prototype, 'getAvatarImage').mockResolvedValue(null),
      vi.spyOn(AvatarService.prototype, 'getHeaderImage').mockResolvedValue(null),
      vi.spyOn(AvatarService.prototype, 'getAvatarMeta').mockResolvedValue(null),
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const routes: Array<[string, (name: string) => string, 'metadata' | 'avatar']> = [
    ['metadata (registry)', (n) => `/mainnet/registry/${n}`, 'metadata'],
    ['metadata (namewrapper)', (n) => `/sepolia/namewrapper/${n}`, 'metadata'],
    ['image', (n) => `/mainnet/registry/${n}/image`, 'metadata'],
    ['rasterize', (n) => `/mainnet/registry/${n}/rasterize`, 'metadata'],
    ['registry-hierarchy', (n) => `/registry-hierarchy/${n}`, 'metadata'],
    ['migration-status', (n) => `/migration-status/${n}`, 'metadata'],
    ['avatar', (n) => `/mainnet/avatar/${n}`, 'avatar'],
    ['avatar meta', (n) => `/mainnet/avatar/${n}/meta`, 'avatar'],
    ['header', (n) => `/mainnet/header/${n}`, 'avatar'],
  ];

  it.each(routes)('%s: 33 labels → 400, 32 labels reach the service', async (_label, path, service) => {
    const stubs = service === 'metadata' ? [checkExpiry] : avatarStubs;

    const rejected = await req(path(OVER_CAP));
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as Record<string, unknown>).error).toBe('Invalid ENS name format');
    for (const stub of stubs) expect(stub).not.toHaveBeenCalled();

    const accepted = await req(path(AT_CAP));
    expect(accepted.status).toBe(404); // the stubbed service verdict
    expect(stubs.some((stub) => stub.mock.calls.some((call) => call[0] === AT_CAP))).toBe(true);
  });
});

describe('services reject a name over the label cap before any lookup', () => {
  it('FallbackService.getRegistryHierarchy throws InvalidNameError without resolving a level', async () => {
    const indexer = { getHierarchy: vi.fn() };
    const resolver = { resolveName: vi.fn() };
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer as never, {} as never, resolver as never, indexer as never);

    await expect(svc.getRegistryHierarchy(OVER_CAP)).rejects.toBeInstanceOf(InvalidNameError);
    expect(indexer.getHierarchy).not.toHaveBeenCalled();
    expect(resolver.resolveName).not.toHaveBeenCalled();
  });
});
