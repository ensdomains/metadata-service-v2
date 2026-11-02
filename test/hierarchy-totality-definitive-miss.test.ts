import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// W3-ROUTES-008: GET /registry-hierarchy remains total when checkExpiry reports
// a clean definitive miss. On main this falls through to httpError (404, no
// Cache-Control, no edge write) instead of a 200 zero-owner placeholder.

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

const edgeStore = new Map<string, { response: Response; cacheControl: string | null }>();
const keyOf = (r: RequestInfo | URL) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;

(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match(req: RequestInfo | URL) {
      return edgeStore.get(keyOf(req))?.response.clone();
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
const REQUEST_URL = `http://localhost${PATH}`;

function makeAppCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) { pending.push(p); },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

const env = createMockEnv() as unknown as Record<string, unknown>;

describe('W3-ROUTES-008: registry hierarchy total on definitive checkExpiry miss', () => {
  beforeEach(() => {
    edgeStore.clear();
    vi.spyOn(MetadataService.prototype, 'checkExpiry')
      .mockRejectedValue(new NotFoundError('not registered', { definitive: true }));
    vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 root-first two-level zero-owner placeholder with normal cache policy, edge write, and no hierarchy-service call', async () => {
    const { ctx, flush } = makeAppCtx();
    const res = await app.request(PATH, undefined, env, ctx);
    await flush();

    // Status 200, not 404.
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=300, stale-while-revalidate=60',
    );

    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      name: NAME,
      hierarchy: [
        { name: 'eth', owner: ZERO, resolver: MAINNET_RESOLVER, level: 1 },
        { name: NAME, owner: ZERO, resolver: MAINNET_RESOLVER, level: 2 },
      ],
    });
    expect(body).not.toHaveProperty('_provenance');

    // No hierarchy-service call.
    expect(MetadataService.prototype.getRegistryHierarchy).not.toHaveBeenCalled();

    // Edge write with correct URL and Cache-Control.
    const entry = edgeStore.get(REQUEST_URL);
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(200);
    expect(entry!.cacheControl).toBe('public, max-age=300');
    const storedBody = await entry!.response.clone().json() as Record<string, unknown>;
    expect(storedBody).toEqual(body);
    expect(storedBody).not.toHaveProperty('_provenance');
  });
});