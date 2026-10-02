import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Blind acceptance test for W3-ROUTES-002. A metadata body rescued from stale
// D1 after the live tier throws UpstreamError must not be published as a
// normal long-lived success.

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

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

import { MetadataService } from '../src/services/metadata';
import { FallbackService } from '../src/services/fallback';
import { D1Service } from '../src/services/d1';
import { UpstreamError } from '../src/services/errors';
import app from '../src/index';

const PATH = '/sepolia/registry/stale-route.eth';
const EDGE_URL = `http://localhost${PATH}`;
const ORDINARY_KV_KEY = 'meta:sepolia:registry:stale-route.eth';
const SHORT_CACHE = 'public, max-age=30';

const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' };

function makeCtx() {
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

beforeEach(() => {
  vi.restoreAllMocks();
  edgeStore.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
  vi.spyOn(FallbackService.prototype, 'getDomainMetadata').mockRejectedValue(
    new UpstreamError('live tier outage for stale-route.eth'),
  );
  vi.spyOn(D1Service.prototype, 'getDomain').mockResolvedValue({
    network: 'sepolia',
    id: `0x${'ab'.repeat(32)}`,
    name: 'stale-route.eth',
    label_name: 'stale-route',
    labelhash: `0x${'cd'.repeat(32)}`,
    parent_id: null,
    owner_id: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809',
    resolver_id: null,
    registrant_id: null,
    expiry_date: '2030-01-01T00:00:00.000Z',
    created_at: '2020-01-01T00:00:00.000Z',
    ttl: null,
    is_migrated: false,
    data_source: 'ensnode',
    last_updated: Date.now(),
    sync_version: 1,
  });
});

describe('W3-ROUTES-002 stale D1 metadata rescue', () => {
  it('publishes rescued metadata with a 30s client and edge cache and no ordinary long-lived KV entry', async () => {
    const { ctx, flush } = makeCtx();
    const res = await app.request(PATH, undefined, env, ctx);
    await flush();

    expect(res.status).toBe(200);
    const body = await res.json() as { name?: string; error?: string; attributes?: Array<{ trait_type: string; value: unknown }> };
    expect(body.error).toBeUndefined();
    expect(body.name).toBe('stale-route.eth');
    expect(body.attributes?.some((attr) => attr.trait_type === 'Created Date')).toBe(true);

    const clientCache = res.headers.get('Cache-Control');
    const edgeCache = edgeStore.get(EDGE_URL)?.headers.get('Cache-Control') ?? null;
    const ordinaryLongLived = vi.mocked(env.METADATA_CACHE.put).mock.calls.filter((call) => {
      const key = String(call[0]);
      const ttl = (call[2] as { expirationTtl?: number } | undefined)?.expirationTtl ?? 0;
      return key === ORDINARY_KV_KEY && ttl > 30;
    }).map((call) => ({
      key: String(call[0]),
      expirationTtl: (call[2] as { expirationTtl?: number } | undefined)?.expirationTtl,
    }));

    expect({
      clientCache,
      edgeCache,
      ordinaryLongLived,
    }).toEqual({
      clientCache: SHORT_CACHE,
      edgeCache: SHORT_CACHE,
      ordinaryLongLived: [],
    });
  });
});
