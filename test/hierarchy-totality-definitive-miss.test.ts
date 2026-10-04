import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { NotFoundError } from '../src/services/errors';

const edgeEntries = new Map<string, Response>();
const fakeDefaultCache = {
  match: vi.fn().mockResolvedValue(undefined),
  put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
    const key = typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
    edgeEntries.set(key, response);
  }),
  delete: vi.fn().mockResolvedValue(false),
};

(globalThis as unknown as { caches: unknown }).caches = { default: fakeDefaultCache };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAINNET_RESOLVER = '0xF29100983E058B709F3D539b0c765937B804AC15';

function makeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  fakeDefaultCache.match.mockClear();
  fakeDefaultCache.put.mockClear();
  fakeDefaultCache.delete.mockClear();
  edgeEntries.clear();
});

describe('registry hierarchy totality', () => {
  it('returns and edge-caches a root-first placeholder when the expiry precheck definitively misses', async () => {
    const checkExpiry = vi.spyOn(MetadataService.prototype, 'checkExpiry').mockRejectedValue(
      new NotFoundError('not found in any source', { definitive: true }),
    );
    const getRegistryHierarchy = vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');
    const { context, flush } = makeExecutionContext();

    const response = await app.request(
      '/registry-hierarchy/precheck-missing.eth?network=mainnet',
      undefined,
      createMockEnv() as unknown as Record<string, unknown>,
      context,
    );
    await flush();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=60');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      name: 'precheck-missing.eth',
      hierarchy: [
        { name: 'eth', owner: ZERO_ADDRESS, resolver: MAINNET_RESOLVER, level: 1 },
        { name: 'precheck-missing.eth', owner: ZERO_ADDRESS, resolver: MAINNET_RESOLVER, level: 2 },
      ],
    });
    expect(body).not.toHaveProperty('_provenance');
    expect(checkExpiry).toHaveBeenCalledOnce();
    expect(checkExpiry).toHaveBeenCalledWith('precheck-missing.eth');
    expect(getRegistryHierarchy).not.toHaveBeenCalled();

    expect(fakeDefaultCache.put).toHaveBeenCalledOnce();
    const edgeResponse = edgeEntries.get(
      'http://localhost/registry-hierarchy/precheck-missing.eth?network=mainnet',
    );
    expect(edgeResponse?.status).toBe(200);
    expect(edgeResponse?.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await edgeResponse?.json()).toEqual(body);
  });
});
