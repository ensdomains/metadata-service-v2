import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { namehash } from 'viem/ens';

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

// WEB-1552: checkExpiry gates every metadata, image and rasterize request (and
// each batch entry) before any other cache, so it must reuse a cached live
// verdict instead of reading the chain on every request, without ever serving a
// live verdict past the name's expiry instant, caching the fail-open path, or
// caching a 410 that a renewal could undo in an isolate the webhook never reaches.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';
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
// Mainnet-style chain: no v2, the v1 registrar is authoritative.
function v1Chain(getExpiry: ReturnType<typeof vi.fn>): Chain {
  return { isV2Configured: vi.fn().mockReturnValue(false), getV2Registration: vi.fn(), getExpiry };
}
const registeredUntil = (expirySec: number) => ({ status: 2, expiry: BigInt(expirySec), owner: OWNER });
const notRegistered = { status: 0, expiry: 0n, owner: ZERO };

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
    const svc = makeService('mainnet', v1Chain(getExpiry));

    await svc.checkExpiry('vitalik.eth');
    await svc.checkExpiry('vitalik.eth');
    expect(getExpiry).toHaveBeenCalledTimes(1);
  });

  // The webhook evicts only in the isolate that handles it, so a cached 410
  // would outlive a renewal in the grace period, or a re-registration, in every
  // other isolate for up to the TTL.
  it('never caches an expired verdict: a renewal on v2 is seen on the next request, with no webhook', async () => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() - 10 * DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getV2Registration).toHaveBeenCalledTimes(2);

    getV2Registration.mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC)); // renewed on chain
    await expect(svc.checkExpiry('gone.eth')).resolves.toBeUndefined();
    expect(getV2Registration).toHaveBeenCalledTimes(3);
  });

  it('never caches an expired verdict: a v1 re-registration is seen on the next request, with no webhook', async () => {
    const getExpiry = vi.fn().mockResolvedValue(BigInt(nowSec() - 120 * DAY_SEC));
    const svc = makeService('mainnet', v1Chain(getExpiry));

    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getExpiry).toHaveBeenCalledTimes(2);

    getExpiry.mockResolvedValue(BigInt(nowSec() + 365 * DAY_SEC)); // registered again
    await expect(svc.checkExpiry('gone.eth')).resolves.toBeUndefined();
    expect(getExpiry).toHaveBeenCalledTimes(3);
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
    // A fail-open cached as live would hide a real 410 for the whole TTL.
    const getV2Registration = vi.fn()
      .mockRejectedValueOnce(new UpstreamError('all RPCs failed'))
      .mockResolvedValue(registeredUntil(nowSec() - DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));

    await expect(svc.checkExpiry('gone.eth')).resolves.toBeUndefined(); // fails open
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });

  it('never caches the fail-open path (v1 registrar unreadable)', async () => {
    const getExpiry = vi.fn()
      .mockRejectedValueOnce(new UpstreamError('all RPCs failed'))
      .mockResolvedValue(BigInt(nowSec() - DAY_SEC));
    const svc = makeService('mainnet', v1Chain(getExpiry));

    await expect(svc.checkExpiry('gone.eth')).resolves.toBeUndefined(); // fails open
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getExpiry).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the name, in any casing', { name: 'Unregistered.ETH' }],
    ['its namehash, in any casing', { namehash: `0x${namehash('unregistered.eth').slice(2).toUpperCase()}` }],
    ['both', { name: 'unregistered.eth', namehash: namehash('unregistered.eth') }],
  ])('evictExpiryVerdict drops a cached live verdict given %s', async (_, identifiers) => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC));
    const chain = v2Chain(getV2Registration);
    chain.getExpiry.mockResolvedValue(BigInt(nowSec() - DAY_SEC)); // its v1 registration has lapsed
    const svc = makeService('sepolia', chain);

    await expect(svc.checkExpiry('unregistered.eth')).resolves.toBeUndefined();
    getV2Registration.mockResolvedValue(notRegistered); // unregistered on v2 before its expiry
    await expect(svc.checkExpiry('unregistered.eth')).resolves.toBeUndefined(); // cached

    svc.evictExpiryVerdict(identifiers);
    await expect(svc.checkExpiry('unregistered.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });

  it('evictExpiryVerdict ignores a namehash that is not 32 bytes of hex', async () => {
    const getV2Registration = vi.fn().mockResolvedValue(registeredUntil(nowSec() + 365 * DAY_SEC));
    const svc = makeService('sepolia', v2Chain(getV2Registration));
    await svc.checkExpiry('fox.eth');

    for (const junk of [42, 'fox.eth', '0x1234', `${namehash('fox.eth')}00`]) {
      expect(() => svc.evictExpiryVerdict({ namehash: junk })).not.toThrow();
    }
    await svc.checkExpiry('fox.eth');
    expect(getV2Registration).toHaveBeenCalledTimes(1);
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

  it('keys each verdict by namehash: the entry bound is also a memory bound, however long the names', async () => {
    // Not every route caps name length before checkExpiry (batch names, the
    // registry/namewrapper param), so a name-keyed cache would keep each 100 KB
    // name a caller made up for the whole TTL.
    const getExpiry = vi.fn().mockResolvedValue(0n); // made up: never registered, so live
    const svc = makeService('mainnet', v1Chain(getExpiry));
    const entries = (svc as unknown as { expiryVerdicts: { entries: Map<string, number> } }).expiryVerdicts.entries;
    const long = `${'a'.repeat(100_000)}.eth`;

    await svc.checkExpiry(long);
    await svc.checkExpiry(long);
    expect(getExpiry).toHaveBeenCalledTimes(1);
    expect([...entries.keys()]).toEqual([namehash(long)]);
    expect(namehash(long)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('still gates a name that ENSIP-15 normalization rejects, instead of throwing on its cache key', async () => {
    // ens_normalize throws on "a_b" (an underscore is allowed only at the start
    // of a label); the key must hash the label the gate reads, as given.
    const getExpiry = vi.fn().mockResolvedValue(BigInt(nowSec() - DAY_SEC));
    const svc = makeService('mainnet', v1Chain(getExpiry));

    await expect(svc.checkExpiry('a_b.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    getExpiry.mockResolvedValue(BigInt(nowSec() + 365 * DAY_SEC));
    await expect(svc.checkExpiry('a_b.eth')).resolves.toBeUndefined();
    await expect(svc.checkExpiry('a_b.eth')).resolves.toBeUndefined();
    expect(getExpiry).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Through the app: the gate sees a renewal on the next request, and POST
// /webhook evicts a live verdict in the isolate that handles it
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
  ENSNODE_MAINNET_V1_URL: 'https://ensnode-v1.test/subgraph',
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

function webhook(identifiers: { name: string | null; namehash: string | null }) {
  return request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'NameUnregistered', protocol: 'v2', block_number: 1, tx_hash: '0x01', log_index: 0,
      contract_address: '0x0000000000000000000000000000000000000001',
      ...identifiers, data: '{}', timestamp: nowSec(),
    }),
  });
}

describe('the expiry gate through the app', () => {
  // v2 registrations by name; a name missing here is not registered on v2.
  // Every v1 registration has lapsed.
  const registrations = new Map<string, ReturnType<typeof registeredUntil>>();
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    // Only the chain reads under test and the leaf rendering are stubbed; the
    // routes, checkExpiry, the verdict cache and the webhook handler are real.
    spies.push(
      vi.spyOn(BlockchainService.prototype, 'isV2Configured').mockReturnValue(true),
      vi.spyOn(BlockchainService.prototype, 'getV2Registration').mockImplementation(
        async (_network, name) => registrations.get(name) ?? notRegistered,
      ),
      vi.spyOn(BlockchainService.prototype, 'getExpiry').mockImplementation(async () => BigInt(nowSec() - DAY_SEC)),
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

  it('a renewal reaches the gate on the next request, with no webhook to this isolate', async () => {
    registrations.set('renewed.eth', registeredUntil(nowSec() - 10 * DAY_SEC)); // lapsed
    expect((await request('/sepolia/registry/renewed.eth/image')).status).toBe(410);

    registrations.set('renewed.eth', registeredUntil(nowSec() + 365 * DAY_SEC)); // renewed on chain
    expect((await request('/sepolia/registry/renewed.eth/image')).status).toBe(200);
  });

  // The webhook is handled on the mainnet services; the verdict lives in the
  // sepolia MetadataService of the same isolate.
  it.each([
    ['the name', 'dropped-by-name.eth', (name: string) => ({ name: name.toUpperCase(), namehash: null })],
    ['only the namehash', 'dropped-by-namehash.eth', (name: string) => ({ name: null, namehash: namehash(name) })],
  ])('an unregister reaches the gate right after a webhook that carries %s', async (_, name, identifiers) => {
    registrations.set(name, registeredUntil(nowSec() + 365 * DAY_SEC));
    expect((await request(`/sepolia/registry/${name}/image`)).status).toBe(200);

    registrations.delete(name); // unregistered on v2 before its expiry
    expect((await request(`/sepolia/registry/${name}/image`)).status).toBe(200); // cached live verdict

    expect((await webhook(identifiers(name))).status).toBe(200);
    expect((await request(`/sepolia/registry/${name}/image`)).status).toBe(410);
  });
});
