import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataService, isDegradedMigrationStatus } from '../src/services/metadata';
import { NotFoundError } from '../src/services/errors';
import { MIGRATION_STATUS } from '../src/types';

// ---------------------------------------------------------------------------
// W3-ROUTES-006 regression: D1 rescue after a non-definitive live miss must
// serve degraded cache headers (max-age=30), not normal healthy-success
// headers (max-age=300, stale-while-revalidate=30).
//
// The test creates a MetadataService with a mocked fallback that throws
// NotFoundError({ definitive: false }) and a mocked D1 that returns a
// migrated row. On the baseline at main, the D1 rescue returns a clean
// (non-degraded) response — no _provenance flag — so the downstream route
// handler publishes it with normal cache headers indistinguishable from a
// healthy hit. The fix must mark the rescued response as degraded so the
// route handler applies CachePresets.error() (max-age=30).
// ---------------------------------------------------------------------------

function makeKV() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

function makeSepoliaMetadataService(): MetadataService {
  return new MetadataService(
    {
      indexerV2Endpoint: 'https://zigens.test/graphql',
      indexerV2ApiVersion: 'v2',
      indexerV1Endpoint: 'https://ensnode-v1.test/subgraph',
      network: 'sepolia',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false, // D1 is stubbed separately below
    },
    makeKV(),
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('W3-ROUTES-006: D1 rescue degraded migration status', () => {
  type Stubbable = {
    fallback: { getMigrationStatus: ReturnType<typeof vi.fn> };
    d1?: { getMigrationStatus: ReturnType<typeof vi.fn> };
  };

  it('D1 rescue after non-definitive miss must be marked as degraded', async () => {
    // This test fails on the main baseline because the D1 rescue response is
    // NOT marked as degraded — there is no _provenance flag on the response.
    // After the fix, the D1 rescue path in getMigrationStatus must call
    // markDegradedMigrationStatus so the downstream route handler can detect
    // the degraded response and apply CachePresets.error() (max-age=30).

    const svc = makeSepoliaMetadataService();

    // Mock fallback: throw NotFoundError with definitive: false
    // (primary indexer was skipped — circuit breaker open or unavailable)
    const nonDefinitiveMiss = new NotFoundError(
      'getMigrationStatus: not found in any source',
      { definitive: false },
    );
    (svc as unknown as Stubbable).fallback = {
      getMigrationStatus: vi.fn().mockRejectedValue(nonDefinitiveMiss),
    };

    // Mock D1: return a migrated row (rescue succeeds)
    (svc as unknown as Stubbable).d1 = {
      getMigrationStatus: vi.fn().mockResolvedValue({
        name: 'non-definitive-migration.eth',
        status: 'migrated',
        owner: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809',
        expiration_date: '2030-01-01T00:00:00.000Z',
      }),
    };

    const result = await svc.getMigrationStatus('non-definitive-migration.eth');

    // The response should be 200 JSON (migrated status from D1)
    expect(result.name).toBe('non-definitive-migration.eth');
    expect(result.status).toBe('migrated');

    // CRITICAL ASSERTION: the response must be marked as degraded.
    // isDegradedMigrationStatus checks the non-enumerable Symbol flag.
    // On the baseline at main, this assertion FAILS because the D1 rescue
    // does not set the degraded marker at all.
    //
    // After the fix, isDegradedMigrationStatus must return true.
    expect(isDegradedMigrationStatus(result)).toBe(true);
  });
});