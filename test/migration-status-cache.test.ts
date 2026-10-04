import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetadataService } from '../src/services/metadata';
import { FallbackService } from '../src/services/fallback';
import { D1Service, type D1MigrationRecord } from '../src/services/d1';
import { UpstreamError } from '../src/services/errors';
import { MIGRATION_STATUS } from '../src/types';
import app from '../src/index';

// Thaw getServices' per-network cache so every test starts fresh. The module-level
// cache in src/index.ts is a plain Map; clearing its private entries before each
// test is the only way to re-create MetadataService with the mocks below.
const _resetServicesCache = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)._fullServices?.clear?.();
};

const env = {
  METADATA_CACHE: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace,
  ASSET_BUCKET: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue({ key: 'k', etag: 'e', size: 0 } as unknown as R2Object),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false, cursor: undefined }),
    head: vi.fn().mockResolvedValue(null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket,
  SVG_CACHE: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace,
  DB: {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
    dump: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ results: [], success: true }),
    withSession: vi.fn().mockReturnThis(),
  } as unknown as D1Database,
  MAINNET_RPC_URL: 'https://mainnet.test',
  SEPOLIA_RPC_URL: 'https://sepolia.test',
};

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('W3-ROUTES-004: migration-status D1 fallback cache TTL', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC1/AC2: D1-rescued migration status must carry Cache-Control: public, max-age=30', async () => {
    // Simulate: FallbackService.getMigrationStatus() throws UpstreamError,
    // then D1Service.getMigrationStatus() returns a migrated row.
    const d1Record: D1MigrationRecord = {
      network: 'sepolia',
      id: '0xstale',
      name: 'stale-migration.eth',
      status: 'migrated',
      owner: '0x1234',
      expiration_date: '2028-01-01T00:00:00Z',
      migration_date: null,
      last_updated: 0,
      sync_version: 1,
    };

    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);

    vi.spyOn(FallbackService.prototype, 'getMigrationStatus')
      .mockRejectedValue(new UpstreamError('indexer 502'));

    vi.spyOn(D1Service.prototype, 'getMigrationStatus')
      .mockResolvedValue(d1Record);

    // The real getMigrationStatus will call fallback → catch → D1 → return.
    // The route handler applies cache headers from the result.
    const res = await app.request(
      '/migration-status/stale-migration.eth?network=sepolia',
      undefined,
      env as unknown as Record<string, unknown>,
      ctx,
    );

    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    expect(body).toEqual({
      name: 'stale-migration.eth',
      status: 'migrated',
      owner: '0x1234',
      expirationDate: '2028-01-01T00:00:00Z',
    });

    // Literal header. toContain('max-age=30') also matches max-age=300.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
  });
});
