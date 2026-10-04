import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// ---- fake caches.default (per-colo L0 edge cache) -----------------------------
const edgeStore = new Map<string, Response>();
const keyOf = (r: RequestInfo | URL) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;
(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match(req: RequestInfo | URL) {
      return edgeStore.get(keyOf(req))?.clone();
    },
    async put(req: RequestInfo | URL, res: Response) {
      edgeStore.set(keyOf(req), res);
    },
    async delete(req: RequestInfo | URL) {
      return edgeStore.delete(keyOf(req));
    },
  },
};

// WASM imports break under vite-node.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn(async () => '<svg/>'),
  initializeFont: vi.fn(async () => {}),
}));
vi.mock('../src/services/font', () => ({
  getSatoshiFont: vi.fn(async () => ({ buffer: new ArrayBuffer(0), base64: '' })),
}));

import { MetadataService } from '../src/services/metadata';
import { NotFoundError } from '../src/services/errors';
import { CONTRACTS } from '../src/services/blockchain';
import app from '../src/index';

const ZERO = '0x0000000000000000000000000000000000000000';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const req = (path: string) =>
  app.request(
    path,
    undefined,
    createMockEnv() as unknown as Record<string, unknown>,
    ctx,
  );

describe('W3-ROUTES-008: registry hierarchy definitive miss totality (blind acceptance)', () => {
  beforeEach(() => {
    edgeStore.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 zero-owner placeholder when checkExpiry throws definitive NotFoundError', async () => {
    const expiry = vi
      .spyOn(MetadataService.prototype, 'checkExpiry')
      .mockRejectedValue(
        new NotFoundError('expiry registration absent', { definitive: true }),
      );
    const hierarchy = vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');

    const response = await req(
      '/registry-hierarchy/precheck-missing.eth?network=mainnet',
    );
    const body = (await response.clone().json()) as {
      name?: string;
      hierarchy?: Array<{ name: string; owner: string }>;
      _provenance?: string;
    };

    // Status must be 200, never 404.
    expect(response.status).toBe(200);

    // Placeholder shape: root-first two-level zero-owner.
    expect(body.name).toBe('precheck-missing.eth');
    expect(
      body.hierarchy?.map(({ name, owner }) => ({ name, owner })),
    ).toEqual([
      { name: 'eth', owner: ZERO },
      { name: 'precheck-missing.eth', owner: ZERO },
    ]);

    // No public _provenance leaked.
    expect(body).not.toHaveProperty('_provenance');

    // Normal hierarchy Cache-Control (client: public, max-age=300, stale-while-revalidate=60).
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, stale-while-revalidate=60',
    );

    // Exactly one expiry call, no hierarchy-service call.
    expect(expiry).toHaveBeenCalledTimes(1);
    expect(expiry).toHaveBeenCalledWith('precheck-missing.eth');
    expect(hierarchy).not.toHaveBeenCalled();

    // Edge write present with max-age=300.
    const storedResponse = edgeStore.get(
      'http://localhost/registry-hierarchy/precheck-missing.eth?network=mainnet',
    );
    expect(storedResponse).toBeDefined();
    expect(storedResponse?.headers.get('Cache-Control')).toBe(
      'public, max-age=300',
    );

    // Stored body also free of _provenance.
    const storedBody = (await storedResponse!.clone().json()) as Record<
      string,
      unknown
    >;
    expect(storedBody).not.toHaveProperty('_provenance');
  });
});