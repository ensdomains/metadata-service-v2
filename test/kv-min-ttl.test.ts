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

describe('MetadataService.getRegistryHierarchy with the internal cache on', () => {
  it('returns a chain-built hierarchy instead of failing on its cache write', async () => {
    const kv = strictKv();
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
    (svc as unknown as { fallback: { getRegistryHierarchy: ReturnType<typeof vi.fn> } }).fallback = {
      getRegistryHierarchy: vi.fn().mockResolvedValue({
        data: { name: 'sub.nick.eth', owner: { id: OWNER }, resolver: { address: RESOLVER } },
        source: 'blockchain',
        usedFallback: true,
      }),
    };

    const result = await svc.getRegistryHierarchy('sub.nick.eth');

    expect(result.hierarchy).toEqual([{ name: 'sub.nick.eth', owner: OWNER, resolver: RESOLVER, level: 3 }]);
    expect(kv.put).toHaveBeenCalledWith(expect.stringContaining('hierarchy'), expect.any(String), { expirationTtl: 60 });
  });
});
