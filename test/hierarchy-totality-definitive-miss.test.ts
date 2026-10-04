import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { NETWORKS } from '../src/types';
import { MetadataService } from '../src/services/metadata';
import { NotFoundError } from '../src/services/errors';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const requestUrl = 'http://localhost/registry-hierarchy/precheck-missing.eth?network=mainnet';

interface EdgeWrite {
  url: string;
  response: Response;
}

const edgeWrites: EdgeWrite[] = [];
const fakeDefaultCache = {
  match: vi.fn().mockResolvedValue(undefined),
  put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    edgeWrites.push({ url, response });
  }),
  delete: vi.fn().mockResolvedValue(false),
};
(globalThis as unknown as { caches: unknown }).caches = { default: fakeDefaultCache };

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
  edgeWrites.length = 0;
  vi.restoreAllMocks();
});

describe('registry hierarchy totality on a definitive expiry precheck miss', () => {
  it('returns and edge-caches the root-first zero-owner placeholder without calling the hierarchy service', async () => {
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockRejectedValue(
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
    const body = await response.json();
    expect(body).toEqual({
      name: 'precheck-missing.eth',
      hierarchy: [
        {
          name: 'eth',
          owner: ZERO_ADDRESS,
          resolver: NETWORKS.mainnet.contracts.resolver,
          level: 1,
        },
        {
          name: 'precheck-missing.eth',
          owner: ZERO_ADDRESS,
          resolver: NETWORKS.mainnet.contracts.resolver,
          level: 2,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('_provenance');
    expect(getRegistryHierarchy).not.toHaveBeenCalled();

    expect(edgeWrites).toHaveLength(1);
    expect(edgeWrites[0].url).toBe(requestUrl);
    expect(edgeWrites[0].response.status).toBe(200);
    expect(edgeWrites[0].response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await edgeWrites[0].response.json()).toEqual(body);
  });
});
