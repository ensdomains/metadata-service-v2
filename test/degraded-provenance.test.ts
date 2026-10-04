import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '../src/services/errors';
import { FallbackService } from '../src/services/fallback';
import { D1Service } from '../src/services/d1';
import type { D1DomainRecord, D1MigrationRecord } from '../src/services/d1';
import { MIGRATION_STATUS } from '../src/types';
import app from '../src/index';

// ---- edge cache double (same pattern as cache-bounds.test.ts) ----------------
interface EdgeEntry {
  response: Response;
  maxAge: number | null;
}
const edgeStore = new Map<string, EdgeEntry>();
const keyOf = (r: RequestInfo | URL | Request) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : (r as Request).url;

const fakeDefaultCache = {
  async match(req: RequestInfo | URL) {
    const e = edgeStore.get(keyOf(req));
    return e ? e.response.clone() : undefined;
  },
  async put(req: RequestInfo | URL, res: Response) {
    const cc = res.headers.get('Cache-Control') ?? '';
    const m = /max-age=(\d+)/.exec(cc);
    edgeStore.set(keyOf(req), { response: res, maxAge: m ? Number(m[1]) : null });
  },
  async delete(req: RequestInfo | URL) {
    return edgeStore.delete(keyOf(req));
  },
};
(globalThis as unknown as { caches: unknown }).caches = { default: fakeDefaultCache };

// ---- KV double that records put calls with their options --------------------
interface KvPutRecord {
  key: string;
  value: string;
  expirationTtl?: number;
}
const kvPuts: KvPutRecord[] = [];
const kvStore = new Map<string, string>();

const recordingKv = {
  get: async (k: string) => kvStore.get(k) ?? null,
  put: async (k: string, v: string, opts?: KVNamespacePutOptions) => {
    kvPuts.push({ key: k, value: v, expirationTtl: opts?.expirationTtl });
    kvStore.set(k, v);
  },
  delete: async (_k: string) => {},
  list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  getWithMetadata: async () => ({ value: null, metadata: null }),
} as unknown as KVNamespace;

// ---- mock env that uses our tracking KV -------------------------------------
function makeEnv() {
  return {
    METADATA_CACHE: recordingKv,
    SVG_CACHE: recordingKv,
    ASSET_BUCKET: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue({ key: 'x', etag: 'x', size: 0, httpMetadata: {} }),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false, cursor: undefined }),
      head: vi.fn().mockResolvedValue(null),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    },
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [], success: true, meta: { changes: 0 } }),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        }),
      }),
      dump: vi.fn(),
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn().mockResolvedValue({ results: [], success: true }),
      withSession: vi.fn().mockReturnThis(),
    },
    ENSNODE_MAINNET_URL: 'https://api.ensnode.test/graphql',
    ENSNODE_SEPOLIA_V2_URL: 'https://api.sepolia.ensnode.test/graphql',
    MAINNET_RPC_URL: 'https://mainnet.test.rpc',
    SEPOLIA_RPC_URL: 'https://sepolia.test.rpc',
    LOG_LEVEL: 'info',
  };
}

// ---- ExecutionContext double ------------------------------------------------
function makeAppCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) { pending.push(p); },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

async function getRoute(path: string) {
  const env = makeEnv() as unknown as Record<string, unknown>;
  const { ctx, flush } = makeAppCtx();
  const res = await app.request(path, undefined, env, ctx);
  await flush();
  return res;
}

// The finding's expected publication contract, literal, not a numeric bound.
async function expectDegradedContract(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');

  const body = await res.json() as Record<string, unknown>;
  expect(body.name).toBe('non-definitive-metadata.eth');
  expect(body).not.toHaveProperty('provenance');
  expect(body).not.toHaveProperty('metadata');
  expect(JSON.stringify(body)).not.toContain('degraded-d1');

  const edgeEntry = edgeStore.get('http://localhost/sepolia/registry/non-definitive-metadata.eth');
  expect(edgeEntry).toBeDefined();
  expect(edgeEntry!.response.headers.get('Cache-Control')).toBe('public, max-age=30');
  expect(edgeEntry!.maxAge).toBe(30);

  const metadataKvPuts = kvPuts.filter(p => p.key.startsWith('meta:'));
  expect(metadataKvPuts).toEqual([]);
}

describe('W3-ROUTES-005: degraded provenance from D1 rescue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    edgeStore.clear();
    kvPuts.length = 0;
    kvStore.clear();
  });

  // ---- helper: build a valid D1 domain record for D1Service.getDomain -------
  const d1DomainRecord: D1DomainRecord = {
    network: 'sepolia',
    id: '0xabc123',
    name: 'non-definitive-metadata.eth',
    label_name: 'non-definitive-metadata',
    labelhash: '0xdef456',
    parent_id: null,
    owner_id: '0xowner1',
    resolver_id: '0xresolver1',
    registrant_id: '0xregistrant1',
    expiry_date: null,
    created_at: null,
    ttl: null,
    is_migrated: false,
    data_source: 'ensnode',
    last_updated: Date.now(),
    sync_version: 1,
  };

  const d1MigrationRecord: D1MigrationRecord = {
    network: 'sepolia',
    id: '0xabc123',
    name: 'non-definitive-metadata.eth',
    status: MIGRATION_STATUS.UNMIGRATED,
    owner: null,
    expiration_date: null,
    migration_date: null,
    last_updated: Date.now(),
    sync_version: 1,
  };

  it('AC1: degraded D1 rescue after non-definitive live miss returns short-lived Cache-Control', async () => {
    // Simulate the finding's exact conditions:
    // - FallbackService throws NotFoundError({ definitive: false })
    vi.spyOn(FallbackService.prototype, 'getDomainMetadata').mockRejectedValue(
      new NotFoundError('non-definitive miss', { definitive: false }),
    );
    // - D1Service.getDomain returns a row
    vi.spyOn(D1Service.prototype, 'getDomain').mockResolvedValue(d1DomainRecord);
    // - D1Service.getMigrationStatus returns UNMIGRATED (called during buildMetadataFromD1Record)
    vi.spyOn(D1Service.prototype, 'getMigrationStatus').mockResolvedValue(d1MigrationRecord);

    // Also need to prevent the chain checkExpiry from failing
    const { MetadataService } = await import('../src/services/metadata');
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);

    const res = await getRoute('/sepolia/registry/non-definitive-metadata.eth');
    await expectDegradedContract(res);
  });

  it('AC2: after fix, degraded D1 rescue returns Cache-Control: max-age=30 and no long-lived KV write', async () => {
    // Same setup as AC1
    vi.spyOn(FallbackService.prototype, 'getDomainMetadata').mockRejectedValue(
      new NotFoundError('non-definitive miss', { definitive: false }),
    );
    vi.spyOn(D1Service.prototype, 'getDomain').mockResolvedValue(d1DomainRecord);
    vi.spyOn(D1Service.prototype, 'getMigrationStatus').mockResolvedValue(d1MigrationRecord);

    const { MetadataService } = await import('../src/services/metadata');
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);

    const res = await getRoute('/sepolia/registry/non-definitive-metadata.eth');
    await expectDegradedContract(res);
  });

  it('does not publish a pre-fix metadata KV entry as healthy success', async () => {
    kvStore.set(
      'meta:sepolia:registry:non-definitive-metadata.eth',
      JSON.stringify({
        metadata: {
          name: 'poisoned-pre-fix.eth',
          description: 'stored by the bug',
          attributes: [],
        },
        createdAt: Date.now(),
        softTtl: 3600,
        migrationStatus: 'unmigrated',
      }),
    );
    vi.spyOn(FallbackService.prototype, 'getDomainMetadata').mockRejectedValue(
      new NotFoundError('non-definitive miss', { definitive: false }),
    );
    vi.spyOn(D1Service.prototype, 'getDomain').mockResolvedValue(d1DomainRecord);
    vi.spyOn(D1Service.prototype, 'getMigrationStatus').mockResolvedValue(d1MigrationRecord);
    const { MetadataService } = await import('../src/services/metadata');
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);

    const res = await getRoute('/sepolia/registry/non-definitive-metadata.eth');

    expect(res.headers.get('X-Cache-Status')).toBe('miss');
    await expectDegradedContract(res);
  });

  it('normal (non-degraded) responses keep normal Cache-Control TTLs', async () => {
    // Regression guard: when the indexer succeeds normally, Cache-Control is unchanged.
    // Mock a successful getDomainMetadata call
    vi.spyOn(FallbackService.prototype, 'getDomainMetadata').mockResolvedValue({
      data: {
        id: '0xabc',
        name: 'fox.eth',
        labelName: 'fox',
        labelhash: '0xabc',
        isMigrated: true,
        owner: { id: '0xowner' },
        expiryDate: String(Math.floor(Date.now() / 1000) + 365 * 86400), // far future
      },
      source: 'indexerV2' as const,
      usedFallback: false,
      fallthroughs: 0,
      v2Consulted: true,
    });

    const { MetadataService } = await import('../src/services/metadata');
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
    vi.spyOn(MetadataService.prototype, 'resolveStatusForImage').mockResolvedValue(MIGRATION_STATUS.MIGRATED);

    // Need to prevent blockchain calls
    const { BlockchainService } = await import('../src/services/blockchain');
    vi.spyOn(BlockchainService.prototype, 'getV2Registries').mockResolvedValue(null);

    const res = await getRoute('/sepolia/registry/fox.eth');

    expect(res.status).toBe(200);
    const cc = res.headers.get('Cache-Control') ?? '';
    // Normal response should use the per-migration-status TTL, not the degraded 30s
    expect(cc).not.toBe('public, max-age=30');
    expect(cc).toMatch(/max-age=\d+/);
    const maxAgeMatch = /max-age=(\d+)/.exec(cc);
    expect(maxAgeMatch).not.toBeNull();
    const maxAge = Number(maxAgeMatch![1]);
    expect(maxAge).toBeGreaterThan(30);
  });
});
