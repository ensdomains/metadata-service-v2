import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// Mock rasterize service to avoid WASM import issues in Vite (same as index.test.ts)
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { BlockchainService } from '../src/services/blockchain';
import { MetadataService, DomainExpiredError } from '../src/services/metadata';
import { ImageCacheService } from '../src/services/image-cache';
import { UpstreamError } from '../src/services/errors';
import { EXPIRY_VERDICT_TTL_MS, EXPIRY_VERDICT_MAX_ENTRIES } from '../src/services/expiry-verdict-cache';
import { MIGRATION_STATUS } from '../src/types';
import { MAX_ENS_NAME_LENGTH } from '../src/utils/ens';

// WEB-1552: checkExpiry gates every metadata, image and rasterize request (and
// each batch entry) before any other cache, so it must reuse a cached verdict
// instead of reading the chain on every request, without ever serving a live
// verdict past the name's expiry instant or caching the fail-open path.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const DAY_SEC = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

type Chain = Record<string, ReturnType<typeof vi.fn>>;

function makeService(network: 'mainnet' | 'sepolia', blockchain: Chain): MetadataService {
  const svc = new MetadataService(
    {
      indexerV2Endpoint: 'https://zigens.test/graphql',
      indexerV2ApiVersion: network === 'sepolia' ? 'v2' : 'v1',
      network,
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
  (svc as unknown as { blockchain: Chain }).blockchain = blockchain;
  return svc;
}

// Sepolia-style chain: v2 deployed, the name REGISTERED on v2 until `expirySec`.
function v2Chain(getV2Registration: ReturnType<typeof vi.fn>): Chain {
  return { isV2Configured: vi.fn().mockReturnValue(true), getV2Registration, getExpiry: vi.fn() };
}
const registeredUntil = (expirySec: number) => ({ status: 2, expiry: BigInt(expirySec), owner: OWNER });

describe('checkExpiry verdict cache', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reuses a live verdict within the TTL: repeat calls (any casing) make no RPC', async () => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await expect(svc.checkExpiry('fox.eth')).resolves.toBeUndefined();
    await expect(svc.checkExpiry('fox.eth')).resolves.toBeUndefined();
    await expect(svc.checkExpiry('FOX.eth')).resolves.toBeUndefined();
    expect(getV2Registration).toHaveBeenCalledTimes(1);
  });

  it('caches the v1 registrar verdict too (network without v2)', async () => {
    const getExpiry = vi.fn().mockResolvedValue(BigInt(nowSec() + 365 * DAY_SEC));
    const svc = makeService('mainnet', { isV2Configured: vi.fn().mockReturnValue(false), getV2Registration: vi.fn(), getExpiry });

    await svc.checkExpiry('vitalik.eth');
    await svc.checkExpiry('vitalik.eth');
    expect(getExpiry).toHaveBeenCalledTimes(1);
  });

  it('caches an expired verdict: the 410 repeats without an RPC', async () => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() - 10 * DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    const first = await svc.checkExpiry('gone.eth').catch((e: unknown) => e);
    const second = await svc.checkExpiry('gone.eth').catch((e: unknown) => e);
    expect(first).toBeInstanceOf(DomainExpiredError);
    expect(second).toBeInstanceOf(DomainExpiredError);
    expect((second as Error).message).toBe((first as Error).message);
    expect(getV2Registration).toHaveBeenCalledTimes(1);
  });

  it('re-reads the chain once the TTL has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await svc.checkExpiry('fox.eth');
    vi.advanceTimersByTime(EXPIRY_VERDICT_TTL_MS - 1);
    await svc.checkExpiry('fox.eth');
    expect(getV2Registration).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await svc.checkExpiry('fox.eth');
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });

  it('never keeps a live verdict past the expiry instant: a name lapsing within the TTL 410s on time', async () => {
    // A TTL-only cache would keep serving the live verdict for the rest of the
    // TTL after the registration lapsed.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    const expirySec = nowSec() + 60; // lapses 60s from now, well within the TTL
    expect(60_000).toBeLessThan(EXPIRY_VERDICT_TTL_MS);
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(expirySec));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await expect(svc.checkExpiry('soon.eth')).resolves.toBeUndefined();
    vi.advanceTimersByTime(59_000);
    await expect(svc.checkExpiry('soon.eth')).resolves.toBeUndefined();
    expect(getV2Registration).toHaveBeenCalledTimes(1); // still before expiry: cached

    vi.advanceTimersByTime(2_000); // 1s past the expiry instant
    await expect(svc.checkExpiry('soon.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });

  it('never caches the fail-open path (v2 registry unreadable)', async () => {
    // A cached fail-open would hide a real 410 for the whole TTL.
    const getV2Registration = vi.fn()
      .mockRejectedValueOnce(new UpstreamError('all RPCs failed'))
      .mockResolvedValue(registeredUntil(nowSec() - DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await expect(svc.checkExpiry('gone.eth')).resolves.toBeUndefined(); // fails open
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getV2Registration).toHaveBeenCalledTimes(2); // outage not cached; the verdict is
  });

  it('never caches the fail-open path (v1 registrar unreadable)', async () => {
    const getExpiry = vi.fn()
      .mockRejectedValueOnce(new UpstreamError('all RPCs failed'))
      .mockResolvedValue(BigInt(nowSec() - DAY_SEC));
    const svc = makeService('mainnet', { isV2Configured: vi.fn().mockReturnValue(false), getV2Registration: vi.fn(), getExpiry });

    await expect(svc.checkExpiry('gone.eth')).resolves.toBeUndefined(); // fails open
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getExpiry).toHaveBeenCalledTimes(2);
  });

  it('evictExpiryVerdict drops the cached verdict (any casing)', async () => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() - DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await expect(svc.checkExpiry('renewed.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    getV2Registration.mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC)); // renewed on chain
    await expect(svc.checkExpiry('renewed.eth')).rejects.toBeInstanceOf(DomainExpiredError); // cached

    svc.evictExpiryVerdict('Renewed.ETH');
    await expect(svc.checkExpiry('renewed.eth')).resolves.toBeUndefined();
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });

  it(`keeps at most EXPIRY_VERDICT_MAX_ENTRIES (${EXPIRY_VERDICT_MAX_ENTRIES}) verdicts, dropping the least recently used`, async () => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));
    const name = (i: number) => `name${i}.eth`;

    for (let i = 0; i < EXPIRY_VERDICT_MAX_ENTRIES; i++) await svc.checkExpiry(name(i));
    expect(getV2Registration).toHaveBeenCalledTimes(EXPIRY_VERDICT_MAX_ENTRIES);

    await svc.checkExpiry(name(0)); // a hit makes name0 the most recently used
    expect(getV2Registration).toHaveBeenCalledTimes(EXPIRY_VERDICT_MAX_ENTRIES);

    await svc.checkExpiry(name(EXPIRY_VERDICT_MAX_ENTRIES)); // one over the bound
    expect(getV2Registration).toHaveBeenCalledTimes(EXPIRY_VERDICT_MAX_ENTRIES + 1);

    await svc.checkExpiry(name(0)); // kept
    await svc.checkExpiry(name(EXPIRY_VERDICT_MAX_ENTRIES)); // kept
    expect(getV2Registration).toHaveBeenCalledTimes(EXPIRY_VERDICT_MAX_ENTRIES + 1);

    await svc.checkExpiry(name(1)); // the least recently used: dropped, so re-read
    expect(getV2Registration).toHaveBeenCalledTimes(EXPIRY_VERDICT_MAX_ENTRIES + 2);
  });

  it(`never stores a key longer than MAX_ENS_NAME_LENGTH (${MAX_ENS_NAME_LENGTH}): the entry bound is also a memory bound`, async () => {
    // Not every route caps name length before checkExpiry (batch names, the
    // registry/namewrapper param), so without this a batch of 100 KB names made
    // up by the caller would each stay in the isolate for the whole TTL.
    const getExpiry = vi.fn().mockResolvedValue(BigInt(nowSec() - DAY_SEC));
    const svc = makeService('mainnet', { isV2Configured: vi.fn().mockReturnValue(false), getV2Registration: vi.fn(), getExpiry });
    const verdicts = (svc as unknown as { expiryVerdicts: { size: number } }).expiryVerdicts;
    const ofLength = (n: number) => `${'a'.repeat(n - 4)}.eth`;

    for (let i = 0; i < 2; i++) { // the longest valid name: cached
      await expect(svc.checkExpiry(ofLength(MAX_ENS_NAME_LENGTH))).rejects.toBeInstanceOf(DomainExpiredError);
    }
    expect(getExpiry).toHaveBeenCalledTimes(1);
    expect(verdicts.size).toBe(1);

    for (const name of [ofLength(MAX_ENS_NAME_LENGTH + 1), ofLength(100_000)]) {
      for (let i = 0; i < 2; i++) { // still gated as before (410), just not cached
        await expect(svc.checkExpiry(name)).rejects.toBeInstanceOf(DomainExpiredError);
      }
    }
    expect(getExpiry).toHaveBeenCalledTimes(5); // every oversized call reads the chain
    expect(verdicts.size).toBe(1); // and none of them was kept
  });
});

// ---------------------------------------------------------------------------
// POST /webhook evicts the verdict in the isolate that handles it
// (app-level, through the Hono app and the real WebhookService)
// ---------------------------------------------------------------------------

function makeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  } as unknown as KVNamespace;
}

const env = {
  METADATA_CACHE: makeKv(),
  SVG_CACHE: makeKv(),
  ASSET_BUCKET: {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  },
  DB: undefined,
  ENSNODE_MAINNET_URL: 'https://ensnode-v1.test/subgraph',
  ENSNODE_SEPOLIA_V2_URL: 'https://zigens.test/graphql',
  ENSNODE_SEPOLIA_V1_URL: 'https://ensnode-sepolia-v1.test/subgraph',
  MAINNET_RPC_URL: 'https://rpc-mainnet.test',
  SEPOLIA_RPC_URL: 'https://rpc-sepolia.test',
  WEBHOOK_ALLOW_UNAUTHENTICATED: 'true', // signature checks are covered by webhook.test.ts
  RATE_LIMIT_DISABLED: 'true',
  LOG_LEVEL: 'error',
} as never;

// ExecutionContext double that collects waitUntil promises, so the test can
// await the webhook's background purge/evict/warm block.
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

async function request(path: string, init?: RequestInit) {
  const { ctx, flush } = makeCtx();
  const res = await app.request(path, init, env, ctx);
  await flush();
  return res;
}

describe('POST /webhook evicts the cached expiry verdict', () => {
  let expirySec = nowSec() - 10 * DAY_SEC; // lapsed
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    // Only the chain read under test and the leaf rendering are stubbed; the
    // routes, checkExpiry, the verdict cache and the webhook handler are real.
    spies.push(
      vi.spyOn(BlockchainService.prototype, 'isV2Configured').mockReturnValue(true),
      vi.spyOn(BlockchainService.prototype, 'getV2Registration').mockImplementation(
        async () => registeredUntil(expirySec),
      ),
      vi.spyOn(MetadataService.prototype, 'resolveStatusForImage').mockResolvedValue(MIGRATION_STATUS.MIGRATED),
      vi.spyOn(ImageCacheService.prototype, 'getImage').mockImplementation(async function (this: ImageCacheService) {
        return {
          svg: '<svg width="518" height="518"></svg>',
          contentType: 'image/svg+xml',
          cacheStatus: 'MISS',
          ttlConfig: this.getTtlConfig(MIGRATION_STATUS.MIGRATED),
        } as unknown as Awaited<ReturnType<ImageCacheService['getImage']>>;
      }),
    );
  });
  afterAll(() => { spies.forEach((s) => s.mockRestore()); });

  it('a renewal reaches the gate right after its webhook, not only after the TTL', async () => {
    const getV2Registration = vi.mocked(BlockchainService.prototype.getV2Registration);

    expect((await request('/sepolia/registry/renewed.eth/image')).status).toBe(410);
    expect(getV2Registration).toHaveBeenCalledTimes(1);

    expirySec = nowSec() + 365 * DAY_SEC; // renewed on chain
    expect((await request('/sepolia/registry/renewed.eth/image')).status).toBe(410); // cached verdict
    expect(getV2Registration).toHaveBeenCalledTimes(1);

    // The webhook is handled on the mainnet services; the verdict lives in the
    // sepolia MetadataService of the same isolate.
    const hook = await request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'NameRenewed', protocol: 'v2', block_number: 1, tx_hash: '0x01', log_index: 0,
        contract_address: '0x0000000000000000000000000000000000000001',
        name: 'Renewed.eth', namehash: null, data: '{}', timestamp: nowSec(),
      }),
    });
    expect(hook.status).toBe(200);

    expect((await request('/sepolia/registry/renewed.eth/image')).status).toBe(200);
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });
});
