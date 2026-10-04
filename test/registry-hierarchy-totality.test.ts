import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';
import { NotFoundError, UpstreamError, RequestDeadlineError } from '../src/services/errors';

// W3-ROUTES-010: The registry-hierarchy route must remain total — it must
// return a 200 root-first zero-owner placeholder hierarchy when the hierarchy
// service itself reports absence, outage, or deadline after a successful expiry
// check. Currently it returns 404/503 error JSON instead.

// ---- fake caches.default (per-colo L0 edge cache) -------------------------
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
import { FallbackService } from '../src/services/fallback';
import { WebhookService } from '../src/services/webhook';
import app from '../src/index';

// checkExpiry succeeds for all tests.
vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
// Other spied services that the app starts in waitUntil.
vi.spyOn(MetadataService.prototype, 'resolveStatusForImage').mockResolvedValue('unmigrated' as never);
vi.spyOn(MetadataService.prototype, 'recordMigrationStatus').mockResolvedValue(undefined);
vi.spyOn(WebhookService.prototype, 'handleWebhook').mockImplementation(
  async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
);

const getHierarchy = vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');

const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' };
const envArg = env as unknown as Record<string, unknown>;

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

async function send(path: string) {
  const { ctx, flush } = makeCtx();
  const res = await app.request(path, undefined, envArg, ctx);
  await flush();
  return res;
}

// ---- helpers -----------------------------------------------------------------
const ZERO = '0x0000000000000000000000000000000000000000';

function expectPlaceholderHierarchy(body: unknown, name: string) {
  const data = body as Record<string, unknown>;
  expect(data.name).toBe(name);
  expect(data).not.toHaveProperty('_provenance');
  const hierarchy = data.hierarchy as Array<Record<string, unknown>>;
  expect(Array.isArray(hierarchy)).toBe(true);
  expect(hierarchy.length).toBeGreaterThan(0);
  // Root first: the first entry is the TLD.
  expect(hierarchy[0].name).toBe('eth');
  // Zero-owner.
  for (const entry of hierarchy) {
    expect(entry.owner).toBe(ZERO);
  }
  // Levels increase.
  for (let i = 1; i < hierarchy.length; i++) {
    expect(hierarchy[i].level).toBeGreaterThan(hierarchy[i - 1].level as number);
  }
}

// ---- tests -------------------------------------------------------------------

function maxAgeOf(cc: string | null): number | null {
  const match = (cc ?? '').match(/(?:^|[,\s])max-age=(\d+)/);
  return match ? Number(match[1]) : null;
}

function storedEdgeMaxAge(): number | null {
  const stored = [...edgeStore.values()][0];
  return stored ? maxAgeOf(stored.headers.get('Cache-Control')) : null;
}

describe('GET /registry-hierarchy/:name totality (W3-ROUTES-010)', () => {
  beforeEach(() => {
    getHierarchy.mockReset();
    edgeStore.clear();
  });

  it('returns 200 placeholder for definitive NotFoundError with normal cache headers', async () => {
    getHierarchy.mockRejectedValueOnce(
      new NotFoundError('not in any source', { definitive: true }),
    );

    const res = await send('/registry-hierarchy/nick.eth?network=mainnet');

    expect(res.status).toBe(200);
    const body = await res.json();
    expectPlaceholderHierarchy(body, 'nick.eth');

    // Normal hierarchy cache: 300s max-age, client and edge.
    expect(maxAgeOf(res.headers.get('Cache-Control'))).toBe(300);
    expect(storedEdgeMaxAge()).toBe(300);
    expect(res.headers.get('Cache-Tag')).toContain('hierarchy');
    expect(getHierarchy).toHaveBeenCalledTimes(1);
  });

  it('returns 200 placeholder for non-definitive NotFoundError with error cache headers', async () => {
    getHierarchy.mockRejectedValueOnce(
      new NotFoundError('circuit breaker open, indexer skipped', { definitive: false }),
    );

    const res = await send('/registry-hierarchy/nick.eth?network=mainnet');

    expect(res.status).toBe(200);
    const body = await res.json();
    expectPlaceholderHierarchy(body, 'nick.eth');

    // Error cache: exactly 30s, not a 300s value that contains the substring.
    expect(maxAgeOf(res.headers.get('Cache-Control'))).toBe(30);
    expect(storedEdgeMaxAge()).toBe(30);
    expect(getHierarchy).toHaveBeenCalledTimes(1);
  });

  it('returns 200 placeholder for UpstreamError with error cache headers', async () => {
    getHierarchy.mockRejectedValueOnce(new UpstreamError('all RPCs failed'));

    const res = await send('/registry-hierarchy/nick.eth?network=mainnet');

    expect(res.status).toBe(200);
    const body = await res.json();
    expectPlaceholderHierarchy(body, 'nick.eth');

    expect(maxAgeOf(res.headers.get('Cache-Control'))).toBe(30);
    expect(storedEdgeMaxAge()).toBe(30);
    expect(getHierarchy).toHaveBeenCalledTimes(1);
  });

  it('returns 200 placeholder for RequestDeadlineError with error cache headers', async () => {
    getHierarchy.mockRejectedValueOnce(
      new RequestDeadlineError('30s request deadline reached'),
    );

    const res = await send('/registry-hierarchy/nick.eth?network=mainnet');

    expect(res.status).toBe(200);
    const body = await res.json();
    expectPlaceholderHierarchy(body, 'nick.eth');

    expect(maxAgeOf(res.headers.get('Cache-Control'))).toBe(30);
    expect(storedEdgeMaxAge()).toBe(30);
    expect(getHierarchy).toHaveBeenCalledTimes(1);
  });

  it('edge-caches the placeholder response', async () => {
    const name = 'edge-cache-test.eth';
    getHierarchy.mockRejectedValueOnce(
      new NotFoundError('not in any source', { definitive: true }),
    );

    // First request — should call getRegistryHierarchy.
    const res1 = await send(`/registry-hierarchy/${name}?network=mainnet`);
    expect(res1.status).toBe(200);
    expect(getHierarchy).toHaveBeenCalledTimes(1);

    // Second request — same URL, should hit edge cache, no new call.
    getHierarchy.mockClear();
    const res2 = await send(`/registry-hierarchy/${name}?network=mainnet`);
    expect(res2.status).toBe(200);
    expect(getHierarchy).not.toHaveBeenCalled();
    const body2 = await res2.json();
    expectPlaceholderHierarchy(body2, name);
  });

  it('keeps the 30s error policy when hierarchy throws an unexpected error', async () => {
    getHierarchy.mockRejectedValueOnce(new Error('kv read failed'));

    const res = await send('/registry-hierarchy/kv-down.eth?network=mainnet');

    expect(res.status).toBe(500);
    expect(maxAgeOf(res.headers.get('Cache-Control'))).toBe(30);
    expect(edgeStore.size).toBe(0);
  });

  it('applies the 30s edge policy when the real hierarchy method reports an outage', async () => {
    getHierarchy.mockRestore();
    const fallback = vi
      .spyOn(FallbackService.prototype, 'getRegistryHierarchy')
      .mockRejectedValue(new UpstreamError('indexer and RPC down'));
    try {
      const res = await send('/registry-hierarchy/swallowed-outage.eth?network=mainnet');
      expect(res.status).toBe(200);
      const body = await res.json();
      expectPlaceholderHierarchy(body, 'swallowed-outage.eth');
      expect(body).not.toHaveProperty('hierarchyErrorCache');
      expect(body).not.toHaveProperty('_provenance');
      expect(maxAgeOf(res.headers.get('Cache-Control'))).toBe(30);
      expect(storedEdgeMaxAge()).toBe(30);
    } finally {
      fallback.mockRestore();
    }
  });
});