import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FallbackService,
  DEFAULT_FALLBACK_CONFIG,
  SHARED_TRIP_AFTER_FAILURES,
  SHARED_TRIP_JITTER_MS,
  type FallbackConfig,
} from '../src/services/fallback';
import { SharedBreakerState, SHARED_BREAKER_READ_CACHE_MS } from '../src/services/breaker-state';
import { MetadataService } from '../src/services/metadata';
import { UpstreamError } from '../src/services/errors';

// WEB-1552: the indexerV2 circuit breaker's trips are shared across isolates
// through KV, so an isolate that has not seen the outage itself does not keep
// probing an indexer another isolate already found down. Only an outage that
// outlasts a cooldown is shared: one failure trips the isolate that saw it.

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

// The promise's value, or HUNG if it has not settled within `ms` (real time).
const HUNG = 'HUNG';
const within = <T>(p: Promise<T>, ms = 100) =>
  Promise.race([p, new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), ms))]);

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
  const shared = new SharedBreakerState(kv as any, KEY, config.indexerV2.healthCheckIntervalMs);
  return new FallbackService(config, v2, {} as any, resolver, v1Hit(), shared);
}

// Makes an isolate whose indexer is down share a trip ending at T0 + cooldown:
// it fails once (a local trip only), and the probe after the cooldown, at T0,
// fails too.
async function shareTrip(fallback: FallbackService, cooldownMs = 60_000) {
  vi.setSystemTime(T0 - cooldownMs);
  await fallback.getDomainMetadata('fox.eth');
  vi.setSystemTime(T0);
  return fallback.getDomainMetadata('fox.eth');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // No jitter on an adopted trip unless a test sets one.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FallbackService — indexer breaker shared across isolates', () => {
  it('a trip shared by one isolate makes another isolate sharing the KV skip the indexer', async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));
    const bV2 = indexer(false);
    const b = isolate(kv, bV2);

    expect((await shareTrip(a)).source).toBe('indexerV1');
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

  it('one upstream failure trips only the isolate that saw it: the trip is not shared', async () => {
    // A transient blip, or one input that makes the indexer error or time out,
    // must not switch the v2 tier off for every isolate.
    const kv = memoryKv();
    const aV2 = indexer(true);
    const a = isolate(kv, aV2);
    const bV2 = indexer(false);
    const b = isolate(kv, bV2);

    expect((await a.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    // The isolate's own breaker trips for the cooldown, as before.
    expect((await a.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    expect(aV2.getDomain).toHaveBeenCalledTimes(1);
    expect(a.getStatus().indexerV2.healthy).toBe(false);

    expect(kv.put).not.toHaveBeenCalled();
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');
  });

  it(`shares the trip after ${SHARED_TRIP_AFTER_FAILURES} failures in a row: the probe after the cooldown failed too`, async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));

    // Concurrent failures of one trip count once.
    vi.setSystemTime(T0 - 60_000);
    await Promise.all(Array.from({ length: 5 }, () => a.getDomainMetadata('fox.eth')));
    expect(kv.put).not.toHaveBeenCalled();

    vi.setSystemTime(T0);
    await a.getDomainMetadata('fox.eth');
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(KEY, String(T0 + 60_000), { expirationTtl: 60 });
  });

  it.each([
    ['a success', { domain: { name: 'fox.eth' } }],
    ['a clean miss', { domain: null }],
  ])('%s from the indexer in between starts the count again', async (_, answer) => {
    const kv = memoryKv();
    const down = new UpstreamError('indexer unreachable');
    const aV2 = indexer(false);
    aV2.getDomain
      .mockRejectedValueOnce(down)
      .mockResolvedValueOnce(answer)
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down);
    const a = isolate(kv, aV2);

    vi.setSystemTime(T0 - 120_000);
    await a.getDomainMetadata('fox.eth'); // failure
    vi.setSystemTime(T0 - 60_000);
    await a.getDomainMetadata('fox.eth'); // the probe gets an answer
    await a.getDomainMetadata('fox.eth'); // failure: the first in a row again
    expect(aV2.getDomain).toHaveBeenCalledTimes(3);
    expect(kv.put).not.toHaveBeenCalled();

    vi.setSystemTime(T0);
    await a.getDomainMetadata('fox.eth'); // the second in a row
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(KEY, String(T0 + 60_000), { expirationTtl: 60 });
  });

  it('adopting another isolate\'s trip does not count as a failure toward sharing', async () => {
    const kv = memoryKv();
    await shareTrip(isolate(kv, indexer(true)));
    expect(kv.put).toHaveBeenCalledTimes(1);

    const bV2 = indexer(true);
    const b = isolate(kv, bV2);
    await b.getDomainMetadata('fox.eth'); // adopts the trip
    expect(bV2.getDomain).not.toHaveBeenCalled();

    // Its first probe after the trip fails: one failure, a local trip only.
    vi.setSystemTime(T0 + 60_000);
    await b.getDomainMetadata('fox.eth');
    await b.getDomainMetadata('fox.eth');
    expect(bV2.getDomain).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);

    // Its next probe, a cooldown later, is its second failure in a row.
    vi.setSystemTime(T0 + 120_000);
    await b.getDomainMetadata('fox.eth');
    expect(kv.put).toHaveBeenCalledTimes(2);
    expect(kv.put).toHaveBeenLastCalledWith(KEY, String(T0 + 180_000), { expirationTtl: 60 });
  });

  it('an adopted trip ends after a random jitter of up to SHARED_TRIP_JITTER_MS, which is not written to KV', async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const kv = memoryKv();
    await shareTrip(isolate(kv, indexer(true)));
    const bV2 = indexer(false);
    const b = isolate(kv, bV2);

    await b.getDomainMetadata('fox.eth'); // adopts the trip, until T0 + 60 s + 5 s
    vi.setSystemTime(T0 + 60_000 + SHARED_TRIP_JITTER_MS / 2 - 1);
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    expect(bV2.getDomain).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 60_000 + SHARED_TRIP_JITTER_MS / 2);
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');

    // KV holds the trip's real end; the adopting isolate wrote nothing.
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.store.get(KEY)).toBe(String(T0 + 60_000));
  });

  it('a far-future value in KV holds the breaker open for one cooldown at most, however often it is re-read', async () => {
    const kv = memoryKv();
    kv.store.set(KEY, String(T0 + 365 * 24 * 3600_000));
    const bV2 = indexer(false);
    const b = isolate(kv, bV2);

    expect(await new SharedBreakerState(kv as unknown as KVNamespace, KEY, 60_000).trippedUntil()).toBe(T0 + 60_000);

    await b.getDomainMetadata('fox.eth');
    vi.setSystemTime(T0 + 30_000); // re-reads the same value
    await b.getDomainMetadata('fox.eth');
    vi.setSystemTime(T0 + 59_999);
    await b.getDomainMetadata('fox.eth');
    expect(bV2.getDomain).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 60_000);
    expect((await b.getDomainMetadata('fox.eth')).source).toBe('indexerV2');
  });

  it('a cooldown shorter than the KV minimum TTL ends on time: the stored deadline decides, not the TTL', async () => {
    const config = { ...DEFAULT_FALLBACK_CONFIG, indexerV2: { ...DEFAULT_FALLBACK_CONFIG.indexerV2, healthCheckIntervalMs: 10_000 } };
    const kv = memoryKv();
    const bV2 = indexer(false);
    const a = isolate(kv, indexer(true), config);
    const b = isolate(kv, bV2, config);

    await shareTrip(a, 10_000);
    expect(kv.put).toHaveBeenCalledTimes(1);
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

  it('a request never waits on another request\'s read: one that never settles blocks no one else', async () => {
    // In Workers a request's I/O never settles once that request is cancelled
    // (client disconnect, timeout), so its read must not be shared.
    const kv = memoryKv();
    kv.get.mockReturnValueOnce(new Promise<null>(() => {}));
    const b = isolate(kv, indexer(false));

    const cancelled = b.getDomainMetadata('fox.eth');
    // Concurrent requests use the last known state and do not read KV again.
    const others = await within(Promise.all(Array.from({ length: 5 }, () => b.getDomainMetadata('fox.eth'))));
    expect(others).not.toBe(HUNG);
    expect(kv.get).toHaveBeenCalledTimes(1);

    // Once the read cache is stale again, the next request reads KV itself.
    vi.setSystemTime(T0 + SHARED_BREAKER_READ_CACHE_MS);
    expect(await within(b.getDomainMetadata('fox.eth'))).toMatchObject({ source: 'indexerV2' });
    expect(kv.get).toHaveBeenCalledTimes(2);
    expect(await within(cancelled)).toBe(HUNG); // only the request that started the stuck read
  });

  it('writes a trip once per outage, not once per concurrently failing request', async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));

    vi.setSystemTime(T0 - 60_000);
    await a.getDomainMetadata('fox.eth');
    vi.setSystemTime(T0);
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

    expect((await shareTrip(a)).source).toBe('indexerV1');
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect((await a.getDomainMetadata('fox.eth')).source).toBe('indexerV1');
    expect(aV2.getDomain).toHaveBeenCalledTimes(2);
  });

  it('resetHealthStatus clears the shared trip for isolates that have not adopted it', async () => {
    const kv = memoryKv();
    const a = isolate(kv, indexer(true));
    await shareTrip(a);
    expect(kv.store.has(KEY)).toBe(true);

    await a.resetHealthStatus();
    expect(kv.delete).toHaveBeenCalledWith(KEY);
    const cV2 = indexer(false);
    expect((await isolate(kv, cV2).getDomainMetadata('fox.eth')).source).toBe('indexerV2');

    // The count of failures in a row starts again: a's next failure is local only.
    await a.getDomainMetadata('fox.eth');
    expect(kv.put).toHaveBeenCalledTimes(1);
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
    // Down for longer than a cooldown: the probe after it fails too.
    vi.setSystemTime(T0 - 60_000);
    await expect(a.getMetadata('sepolia', 'registry', 'fox.eth')).rejects.toBeInstanceOf(UpstreamError);
    vi.setSystemTime(T0);
    await expect(a.getMetadata('sepolia', 'registry', 'fox.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(kv.put).toHaveBeenCalledTimes(1);
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
