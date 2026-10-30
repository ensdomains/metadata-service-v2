import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// W3-ROUTES-008: GET /registry-hierarchy remains total when checkExpiry reports
// a clean definitive miss. On main this currently falls through to httpError
// (404, no Cache-Control, no edge write) instead of a 200 zero-owner placeholder.

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

interface EdgeEntry {
  response: Response;
  cacheControl: string | null;
}
const edgeStore = new Map<string, EdgeEntry>();
const keyOf = (r: RequestInfo | URL | Request) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : (r as Request).url;

(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match(req: RequestInfo | URL) {
      const e = edgeStore.get(keyOf(req));
      return e ? e.response.clone() : undefined;
    },
    async put(req: RequestInfo | URL, res: Response) {
      edgeStore.set(keyOf(req), {
        response: res,
        cacheControl: res.headers.get('Cache-Control'),
      });
    },
    async delete(req: RequestInfo | URL) {
      return edgeStore.delete(keyOf(req));
    },
  },
};

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { NotFoundError } from '../src/services/errors';
import { CONTRACTS } from '../src/services/blockchain';

const NAME = 'precheck-missing.eth';
const PATH = `/registry-hierarchy/${NAME}?network=mainnet`;
const ZERO = '0x0000000000000000000000000000000000000000';
const MAINNET_RESOLVER = CONTRACTS.mainnet.resolver;

function makeAppCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

describe('W3-ROUTES-008: registry hierarchy is total on a definitive checkExpiry miss', () => {
  const env = createMockEnv() as unknown as Record<string, unknown>;
  let checkExpiry: ReturnType<typeof vi.spyOn>;
  let getRegistryHierarchy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    edgeStore.clear();
    checkExpiry = vi.spyOn(MetadataService.prototype, 'checkExpiry')
      .mockRejectedValue(new NotFoundError('not registered', { definitive: true }));
    getRegistryHierarchy = vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a 200 root-first two-level zero-owner placeholder with normal cache policy and no hierarchy-service call', async () => {
    const { ctx, flush } = makeAppCtx();
    const res = await app.request(PATH, undefined, env, ctx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=60');

    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      name: NAME,
      hierarchy: [
        { name: 'eth', owner: ZERO, resolver: MAINNET_RESOLVER, level: 1 },
        { name: NAME, owner: ZERO, resolver: MAINNET_RESOLVER, level: 2 },
      ],
    });
    expect(body).not.toHaveProperty('_provenance');

    expect(checkExpiry).toHaveBeenCalledWith(NAME);
    expect(getRegistryHierarchy).not.toHaveBeenCalled();

    const entry = edgeStore.get(`http://localhost${PATH}`);
    expect(entry).toBeDefined();
    expect(entry!.cacheControl).toBe('public, max-age=300');
  });
});
