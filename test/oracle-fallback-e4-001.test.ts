import { describe, expect, it, vi } from 'vitest';
import { DomainExpiredError, MetadataService } from '../src/services/metadata';

// Blind acceptance test for FALLBACK-E4-001.
// expiry = 2^53 + 3 seconds; Date.now() = Number(expiry) * 1000.
// That represented instant is 1,096 ms after the exact bigint expiry.
// Expected: checkExpiry("precision.eth") throws DomainExpiredError.

describe('FALLBACK-E4-001 expiry comparison precision', () => {
  it('checkExpiry("precision.eth") throws DomainExpiredError when the exact expiry has passed but Number(expiry) * 1000 equals Date.now()', async () => {
    const expiry = 2n ** 53n + 3n;
    const representedNow = Number(expiry) * 1000;
    expect(BigInt(representedNow) - expiry * 1000n).toBe(1096n);
    vi.spyOn(Date, 'now').mockReturnValue(representedNow);

    const svc = new MetadataService(
      {
        indexerV2Endpoint: 'https://indexer.test/graphql',
        indexerV2ApiVersion: 'v1',
        network: 'mainnet',
        fallbackToBlockchain: true,
        internalCacheEnabled: false,
        d1Enabled: false,
      },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
    svc.blockchain = {
      isV2Configured: () => false,
      getExpiry: async () => expiry,
    } as unknown as MetadataService['blockchain'];

    await expect(svc.checkExpiry('precision.eth')).rejects.toBeInstanceOf(DomainExpiredError);
  });
});
