import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FallbackService, DEFAULT_FALLBACK_CONFIG, type FallbackConfig } from '../src/services/fallback';
import { SharedBreakerState, SHARED_BREAKER_READ_CACHE_MS } from '../src/services/breaker-state';
import { MetadataService } from '../src/services/metadata';
import { UpstreamError } from '../src/services/errors';

// WEB-1552: the indexerV2 circuit breaker's trips are shared across isolates
// through KV, so an isolate that has not seen the outage itself does not keep
// probing an indexer another isolate already found down.

const KEY = 'breaker:indexerV2:mainnet';
const T0 = new Date('2026-09-24T12:00:00Z').getTime();

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}
type MemoryKv = ReturnType<typeof memoryKv>;

// v2 indexer double: down (UpstreamError) or up (has the name).
function indexer(down: boolean) {
  return {
    getDomain: vi.fn(async () => {
      if (down) throw new UpstreamError('indexer unreachable');
      return { domain: { name: 'fox.eth' } };
    }),
    getMigrationStatus: vi.fn(),
    getHierarchy: vi.fn(),
  } as any;
}

const v1Hit = () => ({
  getDomain: vi.fn(async () => ({ domain: { name: 'fox.eth' } })),
  getMigrationStatus: vi.fn(),
  getHierarchy: vi.fn(),
} as any);

// One isolate's FallbackService, sharing breaker state through `kv`.
function isolate(kv: MemoryKv, v2: any, config: FallbackConfig = DEFAULT_FALLBACK_CONFIG) {
  const resolver = { resolveName: vi.fn() } as any;
  return new FallbackService(config, v2, {} as any, resolver, v1Hit(), new SharedBreakerState(kv as any, KEY));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FallbackService — indexer breaker shared across isolates', () => {
  it('a trip in one isolate makes another isolate sharing the KV skip the indexer', async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));
    const bV2 = indexer(false);
    const b = isolate(kv, bV2);

    expect((await a.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    // The trip is written once, as the time it ends, with KV's minimum TTL.
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(KEY, String(T0 + 60_000), { expirationTtl: 60 });

    const res = await b.getDomainMetadata('fox.eth');
    expect(res.source).toBe('indexerV1');
    expect(res.v2Consulted).toBe(false);
    expect(bV2.getDomain).not.toHaveBeenCalled();
    expect(b.getStatus().indexerV2.healthy).toBe(false);

    // Once the cooldown is over, the other isolate probes the indexer again.
    vi.setSystemTime(T0 + 60_001);
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');
    expect(bV2.getDomain).toHaveBeenCalledTimes(1);
  });

  it('a cooldown shorter than the KV minimum TTL ends on time: the stored deadline decides, not the TTL', async () => {
    const config = { ...DEFAULT_FALLBACK_CONFIG, indexerV2: { ...DEFAULT_FALLBACK_CONFIG.indexerV2, healthCheckIntervalMs: 10_000 } };
    const kv = memoryKv();
    const bV2 = indexer(false);
    const a = isolate(kv, indexer(true), config);
    const b = isolate(kv, bV2, config);

    await a.getDomainMetadata('fox.eth');
    expect(kv.put).toHaveBeenCalledWith(KEY, String(T0 + 10_000), { expirationTtl: 60 });

    await b.getDomainMetadata('fox.eth');
    expect(bV2.getDomain).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 10_001); // the key is still in KV, the trip is over
    expect(kv.store.has(KEY)).toBe(true);
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');
  });

  it('reads the shared state at most once per read-cache interval, however many requests', async () => {
    const kv = memoryKv();
    const b = isolate(kv, indexer(false));

    await b.getDomainMetadata('fox.eth');
    await Promise.all(Array.from({ length: 5 }, () => b.getDomainMetadata('fox.eth')));
    vi.setSystemTime(T0 + SHARED_BREAKER_READ_CACHE_MS - 1);
    await b.getDomainMetadata('fox.eth');
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith(KEY);

    vi.setSystemTime(T0 + SHARED_BREAKER_READ_CACHE_MS);
    await b.getDomainMetadata('fox.eth');
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it('concurrent reads while the cache is stale share one KV read', async () => {
    const kv = memoryKv();
    const b = isolate(kv, indexer(false));

    await Promise.all(Array.from({ length: 5 }, () => b.getDomainMetadata('fox.eth')));
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('writes a trip once per outage, not once per concurrently failing request', async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));

    await Promise.all(Array.from({ length: 5 }, () => a.getDomainMetadata('fox.eth')));
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('fails open when the KV read errors: the indexer is still tried, and the failure is cached', async () => {
    const kv = memoryKv();
    kv.get.mockRejectedValue(new Error('KV unavailable'));
    const bV2 = indexer(false);
    const b = isolate(kv, bV2);

    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');
    expect(bV2.getDomain).toHaveBeenCalledTimes(2);
    // Read (and failed) once, not once per request.
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('fails open when the KV write errors: the request is served and the local breaker still trips', async () => {
    const kv = memoryKv();
    kv.put.mockRejectedValue(new Error('KV unavailable'));
    const aV2 = indexer(true);
    const a = isolate(kv, aV2);

    expect((await a.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect((await a.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    expect(aV2.getDomain).toHaveBeenCalledTimes(1);
  });

  it('resetHealthStatus clears the shared trip for isolates that have not adopted it', async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));
    await a.getDomainMetadata('fox.eth');

    await a.resetHealthStatus();
    expect(kv.delete).toHaveBeenCalledWith(KEY);
    const cV2 = indexer(false);
    expect((await isolate(kv, cV2).getDomainMetadata('fox.eth')).source).toBe('indexerV2');
  });
});

describe('MetadataService — breaker state wiring', () => {
  const service = (kv: MemoryKv, network: 'mainnet' | 'sepolia') => {
    const svc = new MetadataService(
      {
        indexerV2Endpoint: 'https://indexer.test/graphql',
        network,
        fallbackToBlockchain: false,
        internalCacheEnabled: false,
        d1Enabled: false,
      },
      kv as any,
      {} as any,
    );
    svc.indexerV2.getDomain = vi.fn().mockRejectedValue(new UpstreamError('indexer unreachable'));
    return svc;
  };

  it('shares the breaker through the KV it is given, per network', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const kv = memoryKv();
    const a = service(kv, 'sepolia');
    await expect(a.getMetadata('sepolia', 'registry', 'fox.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(kv.put).toHaveBeenCalledWith('breaker:indexerV2:sepolia', String(T0 + 60_000), { expirationTtl: 60 });

    // Another sepolia isolate skips its indexer; a mainnet one does not.
    const b = service(kv, 'sepolia');
    await expect(b.getMetadata('sepolia', 'registry', 'fox.eth')).rejects.toThrow();
    expect(b.indexerV2.getDomain).not.toHaveBeenCalled();
    const m = service(kv, 'mainnet');
    await expect(m.getMetadata('mainnet', 'registry', 'fox.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(m.indexerV2.getDomain).toHaveBeenCalledTimes(1);
  });
});
