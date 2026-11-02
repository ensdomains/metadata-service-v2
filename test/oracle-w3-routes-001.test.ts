import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// W3-ROUTES-001 oracle. An outage-derived hierarchy placeholder must use the
// 30-second error TTL at the client and the edge. The minimized input is
// GET /registry-hierarchy/outage.eth?network=mainnet after every hierarchy
// source throws UpstreamError and D1 misses. On the main baseline the client
// receives the healthy hierarchy TTL and the edge stores the 300-second cap.

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

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { IndexerService } from '../src/services/indexer';
import { ResolverService } from '../src/services/resolver';
import { UpstreamError } from '../src/services/errors';
import { createMockEnv } from './mocks/hono-env';

const ZERO = '0x0000000000000000000000000000000000000000';
const PATH = '/registry-hierarchy/outage.eth?network=mainnet';
const EDGE_URL = 'http://localhost/registry-hierarchy/outage.eth?network=mainnet';

describe('W3-ROUTES-001 outage hierarchy placeholder TTL', () => {
  beforeEach(() => {
    edgeStore.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
    const outage = () => Promise.reject(new UpstreamError('hierarchy source down'));
    vi.spyOn(IndexerService.prototype, 'getHierarchy').mockImplementation(outage);
    vi.spyOn(ResolverService.prototype, 'resolveName').mockImplementation(outage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the 30-second error TTL at the client and the captured edge', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' };

    const res = await app.request(PATH, undefined, env as unknown as Record<string, unknown>, ctx);
    await Promise.all(pending);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      hierarchy: Array<{ name: string; owner: string }>;
    };
    expect(body.name).toBe('outage.eth');
    expect(body.hierarchy.length).toBeGreaterThan(0);
    expect(body.hierarchy.every((level) => level.owner === ZERO)).toBe(true);
    expect.soft(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect.soft(edgeStore.get(EDGE_URL)?.headers.get('Cache-Control')).toBe('public, max-age=30');
  });
});
