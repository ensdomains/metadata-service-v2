import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Regression pins for the cache-boundary fixes:
//  - /rasterize edge caching goes through edgeCachePut (300s cap), not raw
//    cfCache.put with the full client softTtl (src/index.ts).
//  - SWR revalidation evicts a stale KV entry on a clean NotFoundError /
//    DomainExpiredError verdict, but keeps it on UpstreamError
//    (src/services/metadata-cache.ts).
//  - getV2Registries prefers a just-expired cache entry (newest knowledge)
//    over stale configured addresses when discovery fails
//    (src/services/blockchain.ts).

// ---- fake caches.default (per-colo L0 edge cache) -----------------------------
// Records the Cache-Control max-age each entry was stored with — Cloudflare's
// Cache API derives the edge TTL from the stored response's Cache-Control.
interface EdgeEntry {
  response: Response;
  maxAge: number | null;
}
const edgeStore = new Map<string, EdgeEntry>();
const keyOf = (r: RequestInfo | URL | Request) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : (r as Request).url;

function v3EdgeKey(base: string): string {
  const u = new URL(base);
  u.searchParams.set('__ecv', 'v3');
  return u.toString();
}

const fakeDefaultCache = {
  async match(req: RequestInfo | URL) {
    const e = edgeStore.get(keyOf(req));
    return e ? e.response.clone() : undefined;
  },
  async put(req: RequestInfo | URL, res: Response) {
    const cc = res.headers.get('Cache-Control') ?? '';
    const m = /max-age=(\d+)/.exec(cc);
    edgeStore.set(keyOf(req), { response: res, maxAge: m ? Number(m[1]) : null });
  },
  async delete(req: RequestInfo | URL) {
    return edgeStore.delete(keyOf(req));
  },
};
(globalThis as unknown as { caches: unknown }).caches = { default: fakeDefaultCache };

// Mock rasterize service to avoid WASM import issues in Vite (same as index.test.ts).
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "PNG"
    }
  },
}));

import { MetadataService, DomainExpiredError } from '../src/services/metadata';
import { ImageCacheService } from '../src/services/image-cache';
import { WebhookService } from '../src/services/webhook';
import { MetadataCacheService } from '../src/services/metadata-cache';
import { BlockchainService, ENS_V2_CONTRACTS } from '../src/services/blockchain';
import { NotFoundError, UpstreamError } from '../src/services/errors';
import { MIGRATION_STATUS } from '../src/types';
import type { MetadataResponse } from '../src/types/api';
import app from '../src/index';

// fox.eth is a MIGRATED name (live sepolia fixture). Stub only the
// network-touching methods; keep ImageCacheService.getTtlConfig REAL so the
// softTtl in play (21600s for migrated) comes from actual repo code.
vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
vi.spyOn(MetadataService.prototype, 'resolveStatusForImage').mockResolvedValue(MIGRATION_STATUS.MIGRATED);
vi.spyOn(MetadataService.prototype, 'recordMigrationStatus').mockResolvedValue(undefined);
vi.spyOn(ImageCacheService.prototype, 'getImage').mockImplementation(async function (
  this: ImageCacheService,
  _name,
  options,
) {
  const status = options.migrationStatus ?? 'unmigrated';
  return {
    svg: '<svg width="518" height="518"></svg>',
    contentType: 'image/svg+xml',
    cacheStatus: 'MISS',
    ttlConfig: this.getTtlConfig(status), // REAL repo TTL logic → 21600/86400 for migrated
  } as unknown as Awaited<ReturnType<ImageCacheService['getImage']>>;
});
// Webhook: accept the payload (signature verification is covered by
// webhook.test.ts); the purge/warm waitUntil block in index.ts is the REAL
// code under test.
vi.spyOn(WebhookService.prototype, 'handleWebhook').mockImplementation(
  async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
);

// ExecutionContext double that collects waitUntil promises so tests can
// deterministically await the background edge-cache writes/purges.
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

const env = createMockEnv() as unknown as Record<string, unknown>;

async function get(path: string) {
  const { ctx, flush } = makeAppCtx();
  const res = await app.request(path, undefined, env, ctx);
  await flush(); // let the edge-cache put settle
  return res;
}

beforeEach(() => {
  edgeStore.clear();
});

describe('L0 edge-cache TTL bound (EDGE_CACHE_MAX_AGE_SECS = 300)', () => {
  it('/image route: edge entry is capped at 300s even though client max-age is 21600', async () => {
    // control: /image already went through edgeCachePut before the fix set
    const res = await get('/sepolia/registry/fox.eth/image');
    expect(res.status).toBe(200);
    // Client-facing header keeps the long, purgeable-tier TTL...
    expect(res.headers.get('Cache-Control')).toContain('max-age=21600');
    // ...but the edge copy is capped (edgeCachePut rewrites Cache-Control).
    const entry = edgeStore.get(v3EdgeKey('http://localhost/sepolia/registry/fox.eth/image'));
    expect(entry).toBeDefined();
    expect(entry!.maxAge).toBeLessThanOrEqual(300);
  });

  it('/rasterize route: edge entry is capped at 300s while the client keeps the full softTtl', async () => {
    // regression: /rasterize edge-cached PNGs with the FULL client softTtl (21600s),
    // leaving unpurgeable per-colo copies for ~6h instead of the 300s design bound
    const res = await get('/sepolia/registry/fox.eth/rasterize');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    // Client-facing response keeps the full purgeable-tier TTL...
    expect(res.headers.get('Cache-Control')).toContain('max-age=21600');

    // ...while every caches.default write is bounded by EDGE_CACHE_MAX_AGE_SECS=300
    // because the webhook cannot purge other colos.
    const entry = edgeStore.get(v3EdgeKey('http://localhost/sepolia/registry/fox.eth/rasterize'));
    expect(entry).toBeDefined();
    expect(entry!.maxAge).not.toBeNull();
    expect(entry!.maxAge).toBeLessThanOrEqual(300);
  });

  it('webhook purge: query variants that survive the exact-URL purge are bounded to 300s', async () => {
    // regression: surviving ?w/?h rasterize variants carried the uncapped 21600s TTL,
    // serving a stale PNG for up to 6h after a webhook purge instead of <= 300s
    await get('/sepolia/registry/fox.eth/rasterize');
    await get('/sepolia/registry/fox.eth/rasterize?w=518&h=518');
    expect(edgeStore.size).toBe(2);

    // fox.eth changes its avatar → the indexer fires the webhook.
    const { ctx, flush } = makeAppCtx();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'fox.eth', protocol: 'v2', type: 'update' }),
      },
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await flush(); // run the real purge/warm waitUntil block

    const plain = edgeStore.get(v3EdgeKey('http://localhost/sepolia/registry/fox.eth/rasterize'));
    const sized = edgeStore.get(v3EdgeKey('http://localhost/sepolia/registry/fox.eth/rasterize?w=518&h=518'));

    // The exact query-less URL IS purged (in this colo)...
    expect(plain).toBeUndefined();
    // ...and the sized variant that survives (per-colo cache, no variant
    // enumeration) is bounded by the 300s edge TTL, not the 21600s client TTL.
    expect(sized).toBeDefined();
    expect(sized!.maxAge).not.toBeNull();
    expect(sized!.maxAge).toBeLessThanOrEqual(300);
  });
});

describe('downstream TTL: R2 absolute deadline cap (P2)', () => {
  const IMG = '/sepolia/registry/fox.eth/image';
  const RAS = '/sepolia/registry/fox.eth/rasterize';
  const B = 'http://localhost';
  let now: number; let ns: any = null, is: any = null, as: any = null;

  function r2(upMs: number) { return { text: vi.fn().mockResolvedValue('<svg w="518" h="518"></svg>'), arrayBuffer: vi.fn(), body: null, bodyUsed: false, blob: vi.fn(), json: vi.fn(), uploaded: new Date(upMs) } as any; }
  function cMax(r: Response) { const m = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') ?? ''); return m ? Number(m[1]) : -1; }
  function eMax(p: string) { const e = edgeStore.get(v3EdgeKey(`${B}${p}`)); return e ? e.maxAge : null; }

  beforeEach(async () => {
    edgeStore.clear(); now = Date.now(); ns = vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(ImageCacheService.prototype.getImage).mockRestore();
    ({ ImageGenerationService: is = class{} } = await import('../src/services/image') as any);
    ({ AvatarService: as = class{} } = await import('../src/services/avatar') as any);
    (is as any).prototype.generateDomainImage = vi.fn().mockResolvedValue({ svg: '<svg w="518" h="518"></svg>' });
    (as as any).prototype.getAvatarImage = vi.fn().mockResolvedValue(null);
  });
  afterEach(() => { ns?.mockRestore(); ns = null; delete (is as any)?.prototype?.generateDomainImage; delete (as as any)?.prototype?.getAvatarImage;
    vi.spyOn(ImageCacheService.prototype, 'getImage').mockImplementation(async function (this: ImageCacheService, _n: any, o: any) {
      return { svg: '<svg width="518" height="518"></svg>', contentType: 'image/svg+xml', cacheStatus: 'MISS', ttlConfig: this.getTtlConfig((o as any).migrationStatus ?? 'unmigrated') } as any;
    });
  });

  function sR2(ms: number) { (env.SVG_CACHE as any).get = vi.fn().mockResolvedValue(null); (env.ASSET_BUCKET as any).get = vi.fn().mockResolvedValue(r2(ms)); }

  it('/image: ~300s remaining caps client 300 edge 300', async () => { sR2(now - (86_400_000 - 300_000)); const r = await get(IMG); expect(r.status).toBe(200); expect(cMax(r)).toBe(300); expect(eMax(IMG)).toBe(300); });
  it('/image: ~59.999s remaining caps client 59 edge 59', async () => { sR2(now - (86_400_000 - 59_999)); const r = await get(IMG); expect(r.status).toBe(200); expect(cMax(r)).toBe(59); expect(eMax(IMG)).toBe(59); });
  it('/image: ~1ms remaining caps client 0 no edge put', async () => { sR2(now - (86_400_000 - 1)); const r = await get(IMG); expect(r.status).toBe(200); expect(cMax(r)).toBe(0); expect(eMax(IMG)).toBeNull(); });

  it('/rasterize: 300.001s nominal + 2ms raster delay → client 299 edge 299', async () => {
    sR2(now - (86_400_000 - 300_001));
    const { RasterizeService: RS } = await import('../src/services/rasterize');
    const o = RS.prototype.rasterize; RS.prototype.rasterize = async function (this: any, ...a: any[]) { ns?.mockReturnValue(now + 2); return (o as any).apply(this, a); };
    try { const r = await get(RAS); expect(r.status).toBe(200); expect(cMax(r)).toBe(299); expect(eMax(RAS)).toBe(299); }
    finally { RS.prototype.rasterize = o; ns?.mockReturnValue(now); }
  });

  it('/image: fresh origin MISS keeps full client 21600 edge 300', async () => {
    (env.SVG_CACHE as any).get = vi.fn().mockResolvedValue(null); (env.ASSET_BUCKET as any).get = vi.fn().mockResolvedValue(null);
    const r = await get(IMG); expect(r.status).toBe(200); expect(cMax(r)).toBe(21600); expect(eMax(IMG)).toBe(300);
  });

  // ── KV stale with stored deadline caps TTLs ───────────────────────

  it('/image: KV stale hit with authoritativeDeadlineMs=now+150s caps client 150 edge 150', async () => {
    const dl = now + 150_000;
    (env.SVG_CACHE as any).get = vi.fn().mockResolvedValue(JSON.stringify({
      svg: '<svg w="518" h="518"></svg>', createdAt: dl - 400_000, softTtl: 60, avatarHash: '', migrationStatus: 'migrated',
      authoritativeDeadlineMs: dl,
    }));
    (env.ASSET_BUCKET as any).get = vi.fn().mockResolvedValue(null);
    const r = await get(IMG); expect(r.status).toBe(200);
    // Client max-age must be capped: min(21600, floor((now+150s-now)/1s)) = 150
    expect(cMax(r)).toBe(150);
    // Edge must be capped: min(300, 150) = 150
    expect(eMax(IMG)).toBe(150);
  });
});

// ---- SWR revalidation verdicts (metadata-cache) --------------------------------

// In-memory KV double (only what MetadataCacheService touches).
function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, _opts?: unknown) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

// ExecutionContext double whose collected waitUntil promises can be drained so
// the background revalidation is deterministically awaited.
function makeSwrCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    async drain() {
      await Promise.all(pending.splice(0));
    },
  } as unknown as ExecutionContext & { drain(): Promise<void> };
}

const deadNameMetadata = {
  name: 'burnedname.eth',
  description: 'burnedname.eth, an ENS name.',
  image: 'https://metadata.ens.domains/sepolia/avatar/burnedname.eth',
  attributes: [{ trait_type: 'Migration Status', display_type: 'string', value: 'native' }],
} as unknown as MetadataResponse;

const CACHE_KEY = 'meta:sepolia:registry:burnedname.eth';

function seedStaleEntry(kv: ReturnType<typeof makeKv>) {
  // native name → softTtl 86400s, but the entry is 25h old: stale-but-within-hardTtl.
  kv.store.set(
    CACHE_KEY,
    JSON.stringify({
      metadata: deadNameMetadata,
      createdAt: Date.now() - 25 * 3600 * 1000,
      softTtl: 86400,
      migrationStatus: 'native',
    }),
  );
}

describe('metadata-cache SWR revalidation verdicts', () => {
  it('evicts the stale entry when revalidation hits a clean NotFoundError (burned name)', async () => {
    // regression: a burned name kept serving stale KV metadata until the 30-day
    // hardTtl because the failed revalidate never evicted the entry
    const kv = makeKv();
    const svc = new MetadataCacheService(kv);
    seedStaleEntry(kv);

    // Origin's clean miss: a definitive NotFoundError is thrown only when ALL
    // tiers, the primary index included, missed (name burned while the webhook
    // was down).
    const fetchDead = async (): Promise<MetadataResponse> => {
      throw new NotFoundError('getDomain: not found in any source', { definitive: true });
    };

    // First request: stale hit → background revalidate kicks off.
    const ctx1 = makeSwrCtx();
    const res1 = await svc.get('sepolia', 'registry', 'burnedname.eth', ctx1, fetchDead);
    expect(res1.cacheStatus).toBe('stale'); // SWR still serves the last copy once
    await ctx1.drain(); // revalidate ran → definitive verdict → evict

    expect(kv.store.has(CACHE_KEY)).toBe(false);

    // Second request: cache miss that propagates NotFoundError → index.ts maps to 404.
    const ctx2 = makeSwrCtx();
    await expect(
      svc.get('sepolia', 'registry', 'burnedname.eth', ctx2, fetchDead),
    ).rejects.toThrow(NotFoundError);
  });

  it('keeps the stale entry when the not-found is not definitive (primary index skipped)', async () => {
    const kv = makeKv();
    const svc = new MetadataCacheService(kv);
    seedStaleEntry(kv);
    const fetchUnsure = async (): Promise<MetadataResponse> => {
      throw new NotFoundError('getDomain: not found in any source', { definitive: false });
    };
    const ctx = makeSwrCtx();
    const res = await svc.get('sepolia', 'registry', 'burnedname.eth', ctx, fetchUnsure);
    expect(res.cacheStatus).toBe('stale');
    await ctx.drain().catch(() => {});
    expect(kv.store.has(CACHE_KEY)).toBe(true);
  });

  it('evicts the stale entry when revalidation hits a DomainExpiredError', async () => {
    // regression: an expired name's stale metadata was retained despite the
    // origin's definitive 410 verdict
    const kv = makeKv();
    const svc = new MetadataCacheService(kv);
    seedStaleEntry(kv);

    const fetchExpired = async (): Promise<MetadataResponse> => {
      throw new DomainExpiredError('burnedname.eth', new Date('2026-01-01T00:00:00Z'));
    };

    const ctx1 = makeSwrCtx();
    const res1 = await svc.get('sepolia', 'registry', 'burnedname.eth', ctx1, fetchExpired);
    expect(res1.cacheStatus).toBe('stale');
    await ctx1.drain();

    expect(kv.store.has(CACHE_KEY)).toBe(false);

    const ctx2 = makeSwrCtx();
    await expect(
      svc.get('sepolia', 'registry', 'burnedname.eth', ctx2, fetchExpired),
    ).rejects.toThrow(DomainExpiredError);
  });

  it('keeps the stale entry when revalidation fails with an UpstreamError (SWR contract)', async () => {
    // control: transient upstream failure must NOT evict — that is the point of SWR
    const kv = makeKv();
    const svc = new MetadataCacheService(kv);
    seedStaleEntry(kv);

    const fetchOutage = async (): Promise<MetadataResponse> => {
      throw new UpstreamError('indexer 503');
    };

    const ctx1 = makeSwrCtx();
    const res1 = await svc.get('sepolia', 'registry', 'burnedname.eth', ctx1, fetchOutage);
    expect(res1.cacheStatus).toBe('stale');
    await ctx1.drain();

    expect(kv.store.has(CACHE_KEY)).toBe(true);

    // Next request keeps serving the stale copy instead of failing.
    const ctx2 = makeSwrCtx();
    const res2 = await svc.get('sepolia', 'registry', 'burnedname.eth', ctx2, fetchOutage);
    expect(res2.cacheStatus).toBe('stale');
    expect(res2.metadata.name).toBe('burnedname.eth');
    await ctx2.drain();
  });
});

// ---- getV2Registries: expired cache beats stale config -------------------------

const LIVE = {
  root: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1' as `0x${string}`,
  eth: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2' as `0x${string}`,
};

function makeBlockchainService(): BlockchainService {
  return new BlockchainService({
    MAINNET_RPC_URL: 'http://127.0.0.1:1',
    SEPOLIA_RPC_URL: 'http://127.0.0.1:1',
  });
}

// Instance-level spy on the RPC layer; typed loosely because the method is generic.
function spyExec(svc: BlockchainService) {
  return vi.spyOn(
    svc as unknown as { executeWithFallback: (...args: unknown[]) => Promise<unknown> },
    'executeWithFallback',
  );
}

describe('getV2Registries: discovery failure after cache TTL', () => {
  let nowSpy: { mockRestore(): void } | null = null;
  let now = 0;

  beforeEach(() => {
    now = 1_000_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    // Restore ONLY the Date.now spy — the module-level prototype spies above
    // must survive for the whole file.
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  it('prefers the just-expired cached LIVE registries over stale config when discovery fails', async () => {
    // regression: after the 10-min cache TTL, a transient UR discovery failure fell
    // back to the configured (post-redeploy DEAD) registries, which answer AVAILABLE
    // and misclassify live v2 names as unmigrated
    const svc = makeBlockchainService();
    const exec = spyExec(svc);

    // t=0: UR discovery succeeds and finds the post-redeploy LIVE registries,
    // which differ from the configured (now dead) addresses.
    exec.mockResolvedValue({ result: LIVE, usedFallback: false });
    const first = await svc.getV2Registries('sepolia');
    expect(first).toEqual({ root: LIVE.root, eth: LIVE.eth });

    // Sanity: config really differs from the discovered live addresses.
    const cfg = ENS_V2_CONTRACTS.sepolia;
    expect(cfg.ethRegistry.toLowerCase()).not.toBe(LIVE.eth.toLowerCase());

    // t=11min: cache entry EXPIRED (10-min TTL); UR read fails transiently.
    now += 11 * 60 * 1000;
    exec.mockRejectedValue(new Error('transient: UR proxy read reverted during upgrade window'));

    // The expired cache entry is newer knowledge than the configured addresses.
    const second = await svc.getV2Registries('sepolia');
    expect(second).toEqual({ root: LIVE.root, eth: LIVE.eth });
    expect(second!.eth.toLowerCase()).not.toBe(cfg.ethRegistry.toLowerCase());
  });

  it('control: while the cache is still fresh, cached addresses are served without re-discovery', async () => {
    const svc = makeBlockchainService();
    const exec = spyExec(svc);

    exec.mockResolvedValue({ result: LIVE, usedFallback: false });
    await svc.getV2Registries('sepolia');

    now += 5 * 60 * 1000; // still within the 10-min TTL
    exec.mockRejectedValue(new Error('transient RPC blip'));

    const second = await svc.getV2Registries('sepolia');
    expect(second).toEqual({ root: LIVE.root, eth: LIVE.eth });
    expect(exec).toHaveBeenCalledTimes(1); // fresh cache short-circuits discovery
  });

  it('control: with no cache at all, discovery failure falls back to the configured addresses', async () => {
    const svc = makeBlockchainService();
    const exec = spyExec(svc);

    exec.mockRejectedValue(new Error('transient RPC blip'));

    const result = await svc.getV2Registries('sepolia');
    const cfg = ENS_V2_CONTRACTS.sepolia;
    expect(result).toEqual({ root: cfg.rootRegistry, eth: cfg.ethRegistry });
  });

  it('control: successful discovery repopulates the cache and is served afterwards', async () => {
    const svc = makeBlockchainService();
    const exec = spyExec(svc);

    exec.mockResolvedValue({ result: LIVE, usedFallback: false });
    await svc.getV2Registries('sepolia');

    now += 11 * 60 * 1000; // expire, then discovery succeeds again
    const rediscovered = await svc.getV2Registries('sepolia');
    expect(rediscovered).toEqual({ root: LIVE.root, eth: LIVE.eth });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

// P2: edge cache discriminator — __ecv=v3 on every caches.default key.
describe('L0 edge-cache generation discriminator (v3 isolation)', () => {
  const IMG = '/sepolia/registry/fox.eth/image';
  const RAS = '/sepolia/registry/fox.eth/rasterize';
  const B   = 'http://localhost';

  async function purge(name: string) {
    const { ctx, flush } = makeAppCtx();
    const r = await app.request('/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, protocol: 'v2', type: 'update' }) }, env, ctx);
    expect(r.status).toBe(200);
    await flush();
  }

  beforeEach(() => { edgeStore.clear(); });

  // ── round-trip: miss → put → hit ──────────────────────────────────

  it('/image: round-trip miss→put→hit stores at v3 key and subsequent request hits', async () => {
    const getImageSpy = vi.mocked(ImageCacheService.prototype.getImage);
    const before = getImageSpy.mock.calls.length;

    const r1 = await get(IMG);
    expect(r1.status).toBe(200);
    const body1 = await r1.text();

    const v3k = v3EdgeKey(`${B}${IMG}`);
    expect(edgeStore.has(v3k), 'fresh render must store at v3 key').toBe(true);
    expect(edgeStore.has(`${B}${IMG}`), 'must not store at unversioned key').toBe(false);

    // Second request must hit stored entry and return identical body
    const r2 = await get(IMG);
    expect(await r2.text()).toBe(body1);

    // getImage must be called exactly once: first request renders,
    // second hits the edge cache and never reaches the origin.
    expect(getImageSpy.mock.calls.length - before, 'render origin called exactly once').toBe(1);
  });

  it('/rasterize: round-trip miss→put→hit stores at v3 key', async () => {
    const getImageSpy = vi.mocked(ImageCacheService.prototype.getImage);
    const before = getImageSpy.mock.calls.length;

    const r1 = await get(RAS);
    expect(r1.status).toBe(200);
    const b1 = new Uint8Array(await r1.arrayBuffer());

    const v3k = v3EdgeKey(`${B}${RAS}`);
    expect(edgeStore.has(v3k)).toBe(true);
    expect(edgeStore.has(`${B}${RAS}`)).toBe(false);

    const r2 = await get(RAS);
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(b1);

    expect(getImageSpy.mock.calls.length - before, 'render origin called exactly once').toBe(1);
  });

  // ── unversioned miss, v3 hit ──────────────────────────────────────

  function setE(url: string, body: string, ct = 'image/svg+xml') {
    edgeStore.set(url, { response: new Response(body, { headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=300' } }), maxAge: 300 });
  }

  it('/image: unversioned pre-v3 edge entry misses', async () => {
    setE(`${B}${IMG}`, '<svg>OLD-EDGE</svg>');
    expect(await (await get(IMG)).text()).not.toContain('OLD-EDGE');
  });
  it('/image: v3 edge entry hits', async () => {
    setE(v3EdgeKey(`${B}${IMG}`), '<svg>V3-EDGE</svg>');
    expect(await (await get(IMG)).text()).toContain('V3-EDGE');
  });
  it('/rasterize: unversioned pre-v3 edge entry misses', async () => {
    setE(`${B}${RAS}`, 'OLDPNG', 'image/png');
    expect(new TextDecoder().decode(await (await get(RAS)).arrayBuffer())).not.toBe('OLDPNG');
  });
  it('/rasterize: v3 edge entry hits', async () => {
    setE(v3EdgeKey(`${B}${RAS}`), 'V3PNG', 'image/png');
    expect(new TextDecoder().decode(await (await get(RAS)).arrayBuffer())).toBe('V3PNG');
  });

  // ── webhook purge ─────────────────────────────────────────────────

  it('webhook purge deletes v3 entries (image+rasterize × registry+namewrapper)', async () => {
    for (const rt of ['registry', 'namewrapper'])
      for (const k of ['image', 'rasterize'])
        setE(v3EdgeKey(`${B}/sepolia/${rt}/fox.eth/${k}`), 'x');
    await purge('fox.eth');
    for (const rt of ['registry', 'namewrapper'])
      for (const k of ['image', 'rasterize'])
        expect(edgeStore.has(v3EdgeKey(`${B}/sepolia/${rt}/fox.eth/${k}`))).toBe(false);
  });

  it('webhook purge also deletes legacy unversioned entries for transition', async () => {
    setE(`${B}/sepolia/registry/fox.eth/image`, 'x');
    setE(`${B}/sepolia/registry/fox.eth/rasterize`, 'x');
    await purge('fox.eth');
    expect(edgeStore.has(`${B}/sepolia/registry/fox.eth/image`)).toBe(false);
    expect(edgeStore.has(`${B}/sepolia/registry/fox.eth/rasterize`)).toBe(false);
  });

  // ── duplicate params ──────────────────────────────────────────────

  it('/image: duplicate w param — first value used, ordered duplicates in stored key', async () => {
    await get('/sepolia/registry/fox.eth/image?w=100&w=200&h=518');
    // Key must preserve the original ordered duplicate params as received
    const k = v3EdgeKey(`${B}/sepolia/registry/fox.eth/image?w=100&w=200&h=518`);
    expect(edgeStore.has(k), 'stored key must preserve ordered duplicate params').toBe(true);
    // Renderer must receive the first w value (Hono semantics)
    const lastCall = vi.mocked(ImageCacheService.prototype.getImage).mock.calls.at(-1)!;
    expect(lastCall[1]?.size?.width, 'renderer must use first w=100').toBe(100);
  });

  // ── __ecv sanitisation ────────────────────────────────────────────

  it('client __ecv=old&__ecv=evil — internal key has exactly one __ecv=v3, public clean', async () => {
    const res = await get('/sepolia/registry/fox.eth/image?__ecv=old&__ecv=evil');
    expect(res.status).toBe(200);
    const text = await res.text();
    // Public surface: no __ecv in body or headers
    expect(text).not.toContain('__ecv');
    res.headers.forEach((_, k) => {
      expect(k).not.toContain('__ecv');
      expect(res.headers.get(k)).not.toContain('__ecv');
    });
    // Internal edge key: a single entry whose URL contains exactly one __ecv=v3
    const keys = [...edgeStore.keys()];
    expect(keys.length).toBe(1);
    const edgeKey = keys[0];
    const params = new URL(edgeKey).searchParams;
    expect(params.get('__ecv')).toBe('v3');
    const allEcvs = params.getAll('__ecv');
    expect(allEcvs.length).toBe(1);
    expect(allEcvs[0]).toBe('v3');
  });

  it('no-__ecv request: internal key has exactly one __ecv=v3', async () => {
    await get(IMG);
    const keys = [...edgeStore.keys()];
    expect(keys.length).toBe(1);
    const allEcvs = new URL(keys[0]).searchParams.getAll('__ecv');
    expect(allEcvs).toEqual(['v3']);
  });
});
