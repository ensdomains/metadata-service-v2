import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheService, CacheTTL, KV_MIN_EXPIRATION_TTL_SECS } from '../src/services/cache';
import { MetadataService } from '../src/services/metadata';

// KV rejects an expirationTtl below 60 seconds: the put throws ("Invalid
// expiration_ttl of 30. Expiration TTL must be at least 60."). The registry
// hierarchy cached every chain-built answer, and its last-resort answer, for
// CacheTTL.error (30 s), so the throw turned each of them into a 500.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const RESOLVER = '0x231b0ee14048e9dccd1d247744d114a4eb5e8e63';

// A KV namespace that enforces the minimum TTL the way Cloudflare KV does.
function strictKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(async (_key: string, _value: string, options?: { expirationTtl?: number }) => {
      const ttl = options?.expirationTtl;
      if (ttl !== undefined && ttl < 60) {
        throw new Error(`KV PUT failed: 400 Invalid expiration_ttl of ${ttl}. Expiration TTL must be at least 60.`);
      }
    }),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('CacheService.set', () => {
  it("raises a TTL under KV's minimum to the minimum", async () => {
    const kv = strictKv();
    await new CacheService(kv as unknown as KVNamespace).set('k', { a: 1 }, { ttl: CacheTTL.error });
    expect(kv.put).toHaveBeenCalledWith('indexer:k', expect.any(String), { expirationTtl: KV_MIN_EXPIRATION_TTL_SECS });
  });

  it('never throws when the write fails', async () => {
    const kv = { ...strictKv(), put: vi.fn().mockRejectedValue(new Error('KV unavailable')) };
    await expect(new CacheService(kv as unknown as KVNamespace).set('k', { a: 1 })).resolves.toBeUndefined();
  });
});

// A KV namespace whose every write fails (an outage, or a rate-limited put).
function failingKv() {
  return { ...strictKv(), put: vi.fn().mockRejectedValue(new Error('KV PUT failed: 503 Service Unavailable')) };
}

type HierarchyInternals = {
  fallback: { getRegistryHierarchy: ReturnType<typeof vi.fn> };
  d1?: { getHierarchy: ReturnType<typeof vi.fn> };
};

function hierarchyService(kv: ReturnType<typeof strictKv>) {
  const svc = new MetadataService(
    {
      indexerV2Endpoint: 'https://ensnode.test/graphql',
      network: 'mainnet',
      fallbackToBlockchain: true,
      internalCacheEnabled: true,
      d1Enabled: false,
    },
    kv as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
  return { svc, internals: svc as unknown as HierarchyInternals };
}

const chainBuilt = () =>
  vi.fn().mockResolvedValue({
    data: { name: 'sub.nick.eth', owner: { id: OWNER }, resolver: { address: RESOLVER } },
    source: 'blockchain',
    usedFallback: true,
  });

const allSourcesFail = () => vi.fn().mockRejectedValue(new Error('indexer and RPC unavailable'));

describe('MetadataService.getRegistryHierarchy with the internal cache on', () => {
  it('returns a chain-built hierarchy instead of failing on its cache write', async () => {
    const kv = strictKv();
    const { svc, internals } = hierarchyService(kv);
    internals.fallback = { getRegistryHierarchy: chainBuilt() };

    const result = await svc.getRegistryHierarchy('sub.nick.eth');

    expect(result.hierarchy).toEqual([{ name: 'sub.nick.eth', owner: OWNER, resolver: RESOLVER, level: 3 }]);
    expect(kv.put).toHaveBeenCalledWith(expect.stringContaining('hierarchy'), expect.any(String), { expirationTtl: 60 });
  });
});

// Each answer is cached right before it is returned, so a write that threw
// would fail the request: from the chain-built and D1 paths it would drop to
// the last-resort answer, whose own write would then throw out of the method.
describe('MetadataService.getRegistryHierarchy when every cache write fails', () => {
  it('still returns the chain-built hierarchy', async () => {
    const kv = failingKv();
    const { svc, internals } = hierarchyService(kv);
    internals.fallback = { getRegistryHierarchy: chainBuilt() };

    const result = await svc.getRegistryHierarchy('sub.nick.eth');

    expect(result.hierarchy).toEqual([{ name: 'sub.nick.eth', owner: OWNER, resolver: RESOLVER, level: 3 }]);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('still returns the stale D1 hierarchy when every live source fails', async () => {
    const kv = failingKv();
    const { svc, internals } = hierarchyService(kv);
    const d1Records = [
      { name: 'eth', owner: OWNER, resolver: RESOLVER, level: 1 },
      { name: 'nick.eth', owner: OWNER, resolver: RESOLVER, level: 2 },
    ];
    internals.fallback = { getRegistryHierarchy: allSourcesFail() };
    internals.d1 = { getHierarchy: vi.fn().mockResolvedValue(d1Records) };

    const result = await svc.getRegistryHierarchy('nick.eth');

    expect(result).toEqual({ name: 'nick.eth', hierarchy: d1Records });
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('still returns the last-resort basic hierarchy, whose write comes right before the return', async () => {
    const kv = failingKv();
    const { svc, internals } = hierarchyService(kv);
    internals.fallback = { getRegistryHierarchy: allSourcesFail() };

    const result = await svc.getRegistryHierarchy('sub.nick.eth');

    const zero = '0x0000000000000000000000000000000000000000';
    const resolver = expect.stringMatching(/^0x[0-9a-fA-F]{40}$/);
    expect(result).toEqual({
      name: 'sub.nick.eth',
      hierarchy: [
        { name: 'eth', owner: zero, resolver, level: 1 },
        { name: 'nick.eth', owner: zero, resolver, level: 2 },
        { name: 'sub.nick.eth', owner: zero, resolver, level: 3 },
      ],
    });
    expect(kv.put).toHaveBeenCalledTimes(1);
  });
});
