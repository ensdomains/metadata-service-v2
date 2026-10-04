import { describe, expect, it, vi } from 'vitest';
import { namehash } from 'viem/ens';
import { MetadataService } from '../../src/services/metadata';
import { labelhash } from '../../src/utils/ens';

// Blind acceptance test for W8-EXPIRY-001. Drives checkExpiry and
// evictExpiryVerdict, the functions the ticket names. A read that started
// before eviction must not satisfy the next request when it completes after.

const NAME = 'a.eth';
const DAY_SEC = 86400;
const stableFuture = () => BigInt(Math.floor(Date.now() / 1000) + 365 * DAY_SEC);

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('W8-EXPIRY-001 in-flight eviction', () => {
  it.each([
    ['canonical name', { name: NAME }],
    ['matching namehash', { namehash: namehash(NAME) }],
  ])('re-reads after eviction by %s once a paused v1 read completes', async (_label, evict) => {
    const order: string[] = [];
    const firstRead = deferred<bigint>();
    const secondRead = deferred<bigint>();
    const expiry = stableFuture();
    const getExpiry = vi.fn(() => {
      order.push('read');
      return order.filter((entry) => entry === 'read').length === 1
        ? firstRead.promise
        : secondRead.promise;
    });
    const svc = makeService('mainnet', {
      isV2Configured: vi.fn().mockReturnValue(false),
      getV2Registration: vi.fn(),
      getExpiry,
    });

    const first = svc.checkExpiry(NAME);
    expect(getExpiry).toHaveBeenCalledTimes(1);
    expect(getExpiry).toHaveBeenCalledWith('mainnet', labelhash('a'));

    svc.evictExpiryVerdict(evict);
    order.push('evict');
    firstRead.resolve(expiry);
    await expect(first).resolves.toBeUndefined();
    order.push('settled-1');

    let secondSettled = false;
    const second = svc.checkExpiry(NAME).then((value) => {
      secondSettled = true;
      return value;
    });
    await flush();

    expect({ secondSettled, order, reads: getExpiry.mock.calls.length }).toEqual({
      secondSettled: false,
      order: ['read', 'evict', 'settled-1', 'read'],
      reads: 2,
    });
    expect(getExpiry).toHaveBeenNthCalledWith(2, 'mainnet', labelhash('a'));

    secondRead.resolve(expiry);
    await expect(second).resolves.toBeUndefined();
    expect(getExpiry).toHaveBeenCalledTimes(2);
  });

  it('re-reads after a paused v2 live read completes following eviction', async () => {
    const order: string[] = [];
    const firstRead = deferred<{ status: number; expiry: bigint }>();
    const secondRead = deferred<{ status: number; expiry: bigint }>();
    const expiry = stableFuture();
    const live = { status: 2, expiry };
    const getV2Registration = vi.fn(() => {
      order.push('read');
      return order.filter((entry) => entry === 'read').length === 1
        ? firstRead.promise
        : secondRead.promise;
    });
    const getExpiry = vi.fn();
    const svc = makeService('sepolia', {
      isV2Configured: vi.fn().mockReturnValue(true),
      getV2Registration,
      getExpiry,
    });

    const first = svc.checkExpiry(NAME);
    expect(getV2Registration).toHaveBeenCalledTimes(1);
    expect(getV2Registration).toHaveBeenCalledWith('sepolia', NAME);

    svc.evictExpiryVerdict({ name: NAME });
    order.push('evict');
    firstRead.resolve(live);
    await expect(first).resolves.toBeUndefined();
    order.push('settled-1');

    let secondSettled = false;
    const second = svc.checkExpiry(NAME).then((value) => {
      secondSettled = true;
      return value;
    });
    await flush();

    expect({ secondSettled, order, reads: getV2Registration.mock.calls.length }).toEqual({
      secondSettled: false,
      order: ['read', 'evict', 'settled-1', 'read'],
      reads: 2,
    });
    expect(getExpiry).not.toHaveBeenCalled();

    secondRead.resolve(live);
    await expect(second).resolves.toBeUndefined();
    expect(getV2Registration).toHaveBeenCalledTimes(2);
  });

  it('unrelated eviction does not invalidate an in-flight v1 read for a different name', async () => {
    const firstRead = deferred<bigint>();
    const expiry = stableFuture();
    const getExpiry = vi.fn(() => firstRead.promise);
    const svc = makeService('mainnet', {
      isV2Configured: vi.fn().mockReturnValue(false),
      getV2Registration: vi.fn(),
      getExpiry,
    });

    const first = svc.checkExpiry(NAME);
    expect(getExpiry).toHaveBeenCalledTimes(1);

    // Evict an unrelated name while a.eth's read is in flight.
    svc.evictExpiryVerdict({ name: 'unrelated.eth' });
    firstRead.resolve(expiry);
    await expect(first).resolves.toBeUndefined();

    // The next checkExpiry for a.eth must be a cache hit — the unrelated
    // eviction must not have invalidated this name's in-flight fill.
    let secondRead = false;
    const second = svc.checkExpiry(NAME).then(() => {
      secondRead = true;
    });
    await flush();

    // Already settled — no second chain read needed, isLive returns true.
    expect(secondRead).toBe(true);
    expect(getExpiry).toHaveBeenCalledTimes(1);
  });
});
