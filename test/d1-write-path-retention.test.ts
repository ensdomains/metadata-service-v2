import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockKV, createMockR2 } from './mocks/hono-env';
import { namehash, labelhash } from '../src/utils/ens';
import {
  D1Service,
  D1_READ_MAX_AGE_MS,
  D1_RETENTION_MS,
  D1_CLEANUP_CHUNK_ROWS,
  D1_CLEANUP_MAX_CHUNKS,
  SYNC_STATUS_WRITE_INTERVAL_MS,
} from '../src/services/d1';
import { SyncService, DEFAULT_SYNC_CONFIG } from '../src/services/sync';
import { MetadataService, type MetadataServiceConfig } from '../src/services/metadata';
import type { IndexerDomain } from '../src/services/indexer';
import { UpstreamError } from '../src/services/errors';

// WEB-1553 / WEB-1551: the D1 write path and retention.
//  - the per-request D1 sync runs after the response (waitUntil) and reuses the
//    domain getMetadata already fetched, instead of a second indexer query;
//  - multi-row writes go in one db.batch();
//  - the sync_status row is not rewritten on every sync;
//  - rows older than the read max age are a miss (never served as current);
//  - a daily cron deletes rows past the retention period and logs the counts.

// node:sqlite is not on vite's builtin allowlist and is absent on older Node
// lines: load it at runtime and skip the real-SQL suites where it is missing
// (same pattern as webhook-warming.test.ts).
const nodeRequire = createRequire(import.meta.url);
let DatabaseSyncImpl: typeof import('node:sqlite').DatabaseSync | null = null;
try {
  ({ DatabaseSync: DatabaseSyncImpl } = nodeRequire('node:sqlite') as typeof import('node:sqlite'));
} catch {
  console.warn('[d1-write-path-retention.test] node:sqlite unavailable on this Node — skipping real-SQL D1 suites');
}
const hasSqlite = DatabaseSyncImpl !== null;

// Exact operational boundary and gap values for envSecsToMs guard regressions.
const MAX_ENV_SECS = 10 * 365 * 24 * 60 * 60; // 315,360,000
const MAX_PLUS_ONE  = MAX_ENV_SECS + 1;        // 315,360,001
// MAX_SAFE_INTEGER / 1000 ≈ 9,007,199,254.741; floor is 9,007,199,254,741.
const SAFE_SECS_UNSAFE_MS = 9_007_199_254_741;

type SqliteDb = InstanceType<NonNullable<typeof DatabaseSyncImpl>>;

// The real schema, straight from the latest migration.
const SCHEMA = readFileSync(
  fileURLToPath(new URL('../migrations/002_network_scoping.sql', import.meta.url)),
  'utf8',
);

function openSqlite(): SqliteDb {
  if (!DatabaseSyncImpl) throw new Error('node:sqlite unavailable (suite should have been skipped)');
  const db = new DatabaseSyncImpl(':memory:');
  db.exec(SCHEMA);
  return db;
}

// Minimal D1Database shim backed by real SQLite, with batch() as one
// transaction like D1's. Records each top-level run() and batch() call, and can
// hold every query behind `gate` (to prove what does NOT wait for D1). Each
// call also takes a timer turn, like the network round trip a D1 query is: a
// sync that is neither awaited nor handed to waitUntil is then still running
// when the waitUntil tasks settle, instead of finishing in the same microtask
// flush as synchronous SQLite would let it.
function makeSqliteD1(db: SqliteDb, gate?: Promise<void>) {
  const runs: string[] = [];
  let batches = 0;
  const io = async () => {
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const exec = (sql: string, params: unknown[]) => {
    const r = db.prepare(sql).run(...(params as never[]));
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  };
  type Stmt = { sql: string; params: unknown[] };
  const stmt = (sql: string, params: unknown[] = []): unknown => ({
    sql,
    params,
    bind: (...p: unknown[]) => stmt(sql, p),
    run: async () => {
      await io();
      runs.push(sql);
      return exec(sql, params);
    },
    first: async () => {
      await io();
      return db.prepare(sql).get(...(params as never[])) ?? null;
    },
    all: async () => {
      await io();
      return { results: db.prepare(sql).all(...(params as never[])), success: true, meta: {} };
    },
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: Stmt[]) => {
      await io();
      batches++;
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => exec(s.sql, s.params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { d1, runs, batchCount: () => batches };
}

const DAY = 24 * 60 * 60 * 1000;
const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

function seedDomain(db: SqliteDb, network: string, name: string, lastUpdated: number) {
  const label = name.split('.')[0];
  db.prepare(
    `INSERT INTO domains (network, id, name, label_name, labelhash, owner_id, last_updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(network, namehash(name), name, label, labelhash(label), OWNER, lastUpdated);
}

function seedMigration(db: SqliteDb, network: string, name: string, lastUpdated: number) {
  db.prepare(
    `INSERT INTO migration_status (network, id, name, status, last_updated) VALUES (?1, ?2, ?3, 'native', ?4)`,
  ).run(network, namehash(name), name, lastUpdated);
}

function seedHierarchy(db: SqliteDb, network: string, root: string, name: string, level: number, lastUpdated: number) {
  db.prepare(
    `INSERT INTO registry_hierarchy (network, id, name, owner, resolver, level, root_domain_id, last_updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).run(network, namehash(name), name, OWNER, ZERO, level, namehash(root), lastUpdated);
}

function rowCount(db: SqliteDb, table: string, network?: string): number {
  const row = network
    ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE network = ?1`).get(network)
    : db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number((row as { n: number }).n);
}

// A zigens (v2 dialect) domain row for a subname: subnames skip the 2LD expiry
// gate, so a metadata request touches nothing but the indexer.
function v2Domain(name: string): IndexerDomain {
  const label = name.split('.')[0];
  return {
    id: name,
    name,
    labelName: label,
    labelhash: labelhash(label),
    expiryDate: String(Math.floor(Date.now() / 1000) + 365 * 86400),
    createdAt: '1700000000',
    isMigrated: false,
    protocol: 'v2',
    owner: { id: OWNER },
    resolver: { address: ZERO },
  } as IndexerDomain;
}

const BLOCKCHAIN_ENV = { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' };

function makeService(db: D1Database | undefined, config: Partial<MetadataServiceConfig> = {}): MetadataService {
  return new MetadataService(
    {
      indexerV2Endpoint: 'https://zigens.test/graphql',
      indexerV2ApiVersion: 'v2',
      network: 'sepolia',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: true,
      ...config,
    },
    createMockKV(),
    BLOCKCHAIN_ENV,
    db,
  );
}

function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { tasks.push(p); }),
    passThroughOnException: () => {},
  };
  return { ctx, tasks, drain: () => Promise.allSettled(tasks) };
}

function deferred() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

const TIMED_OUT = Symbol('timed out');
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([promise, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);
}

// ---- Worker-level harness (real Hono app, GraphQL answered by a fetch stub) --

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    METADATA_CACHE: createMockKV(),
    SVG_CACHE: createMockKV(),
    ASSET_BUCKET: createMockR2(),
    DB: undefined,
    ENSNODE_MAINNET_V1_URL: 'https://api.ensnode.test/graphql',
    ENSNODE_SEPOLIA_V2_URL: 'https://zigens.test/graphql',
    ENSNODE_SEPOLIA_V1_URL: 'https://v1subgraph.test/graphql',
    MAINNET_RPC_URL: 'https://mainnet.test.rpc',
    SEPOLIA_RPC_URL: 'https://sepolia.test.rpc',
    RATE_LIMIT_DISABLED: 'true',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

// Fresh app per test: src/index.ts caches services (and so the D1 binding) per
// network at module level.
async function loadApp() {
  vi.resetModules();
  return (await import('../src/index')).default;
}

// Answers the indexer's GraphQL queries: GetDomain returns a v2 row for the
// requested name, everything else is a clean miss. Records each operation.
function stubIndexer() {
  const ops: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://zigens.test/')) throw new TypeError(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: { name?: string } };
    const op = /query (\w+)/.exec(body.query)?.[1] ?? 'unknown';
    ops.push(op);
    const data = op === 'GetDomain' && body.variables?.name
      ? { domain: v2Domain(body.variables.name) }
      : { domain: null };
    return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
  }));
  return ops;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- (a) D1 sync off the response path, no second indexer query -------------

describe.skipIf(!hasSqlite)('metadata request → D1 sync runs after the response', () => {
  it('GET metadata responds before the D1 sync runs, and the sync reuses the fetched domain', async () => {
    // regression: getMetadata awaited syncDomain inline, which re-queried the
    // indexer for the domain it already had and made D1 reads/writes before the
    // response was sent.
    const sqlite = openSqlite();
    const { gate, open } = deferred();
    const { d1 } = makeSqliteD1(sqlite, gate); // every D1 query waits for the gate
    const ops = stubIndexer();
    const app = await loadApp();
    const { ctx, drain } = makeCtx();

    const res = await within(
      Promise.resolve(app.request('/sepolia/registry/sub.fox.eth', undefined, makeEnv({ DB: d1 }), ctx as unknown as ExecutionContext)),
      2000,
    );
    open(); // release D1 (also un-sticks the request when the sync is awaited inline)

    expect(res).not.toBe(TIMED_OUT); // answered while D1 was still blocked
    expect((res as Response).status).toBe(200);
    expect(((await (res as Response).json()) as { name: string }).name).toBe('sub.fox.eth');

    // The runtime only waits for waitUntil tasks: the row is there once they
    // settle only if the route passed its ctx and the sync was registered.
    await drain();
    expect(ops.filter((op) => op === 'GetDomain')).toHaveLength(1); // no second query
    const row = sqlite.prepare('SELECT name, label_name FROM domains WHERE network = ?1').get('sepolia') as
      { name: string; label_name: string };
    expect(row).toEqual({ name: 'sub.fox.eth', label_name: 'sub' });
  });

  it('POST /batch-metadata also runs each sync after the response, one indexer query per name', async () => {
    const sqlite = openSqlite();
    const { gate, open } = deferred();
    const { d1 } = makeSqliteD1(sqlite, gate);
    const ops = stubIndexer();
    const app = await loadApp();
    const { ctx, drain } = makeCtx();

    const res = await within(
      Promise.resolve(app.request(
        '/batch-metadata',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ network: 'sepolia', names: ['sub.fox.eth', 'other.fox.eth'] }),
        },
        makeEnv({ DB: d1 }),
        ctx as unknown as ExecutionContext,
      )),
      2000,
    );
    open();

    expect(res).not.toBe(TIMED_OUT);
    expect(((await (res as Response).json()) as { successful: number }).successful).toBe(2);

    await drain(); // as above: the rows only exist if each sync was registered
    expect(ops.filter((op) => op === 'GetDomain')).toHaveLength(2);
    expect(rowCount(sqlite, 'domains', 'sepolia')).toBe(2);
  });

  it('getMetadata hands the whole D1 sync to waitUntil', async () => {
    // A promise that is started but neither awaited nor registered can be
    // cancelled once the response and the other waitUntil work finish, and D1
    // would silently stop being filled.
    const sqlite = openSqlite();
    const { gate, open } = deferred();
    stubIndexer(); // the sync's migration/hierarchy follow-up queries
    const svc = makeService(makeSqliteD1(sqlite, gate).d1);
    (svc as unknown as { fallback: { getDomainMetadata: unknown } }).fallback = {
      getDomainMetadata: vi.fn().mockResolvedValue({
        data: v2Domain('sub.fox.eth'), source: 'indexerV2', usedFallback: false, v2Consulted: true, retries: 0,
      }),
    };
    const { ctx } = makeCtx();

    const res = await within(svc.getMetadata('sepolia', 'registry', 'sub.fox.eth', 'https://meta.test', ctx), 2000);
    expect(res).not.toBe(TIMED_OUT);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(rowCount(sqlite, 'domains')).toBe(0); // D1 still blocked

    open();
    await ctx.waitUntil.mock.calls[0][0]; // the registered promise covers the store
    expect(rowCount(sqlite, 'domains', 'sepolia')).toBe(1);
  });

  it('a name served from the secondary v1 subgraph is not synced (no re-query of the primary)', async () => {
    // syncDomain only ever stored what the primary indexer returns; for an
    // indexerV1 hit the primary just missed, so querying it again was waste.
    const { d1 } = makeSqliteD1(openSqlite());
    const svc = makeService(d1);
    (svc as unknown as { fallback: { getDomainMetadata: unknown } }).fallback = {
      getDomainMetadata: vi.fn().mockResolvedValue({
        data: v2Domain('old.eth'), source: 'indexerV1', usedFallback: true, v2Consulted: true, retries: 1,
      }),
    };
    const getDomain = vi.spyOn(svc.indexerV2, 'getDomain').mockResolvedValue({ domain: null, usedFallback: false });
    const { ctx, drain } = makeCtx();

    await svc.getMetadata('sepolia', 'registry', 'old.eth', 'https://meta.test', ctx);
    await drain();

    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(getDomain).not.toHaveBeenCalled();
  });

  it('syncDomain(name) without a fetched domain still queries the indexer (other callers)', async () => {
    const d1 = {
      getDomain: vi.fn().mockResolvedValue(null),
      storeDomain: vi.fn(),
      getMigrationStatus: vi.fn().mockResolvedValue(null),
      updateSyncStatus: vi.fn(),
    };
    const indexer = {
      apiVersion: 'v2',
      getDomain: vi.fn().mockResolvedValue({ domain: v2Domain('sub.fox.eth'), usedFallback: false }),
      getMigrationStatus: vi.fn().mockResolvedValue({ status: null, usedFallback: false }),
      getHierarchy: vi.fn().mockResolvedValue({ hierarchy: null, usedFallback: false }),
    };
    const sync = new SyncService(d1 as never, indexer as never, DEFAULT_SYNC_CONFIG);

    await sync.syncDomain('sub.fox.eth');
    expect(indexer.getDomain).toHaveBeenCalledTimes(1);

    const fetched = v2Domain('other.fox.eth');
    await sync.syncDomain('other.fox.eth', false, fetched);
    expect(indexer.getDomain).toHaveBeenCalledTimes(1); // not queried again
    expect(d1.storeDomain).toHaveBeenLastCalledWith(fetched, 'ensnode');
  });
});

// ---- (b) multi-row writes in one db.batch() ----------------------------------

describe.skipIf(!hasSqlite)('D1 multi-row writes use one batch', () => {
  it('storeDomains writes every row in a single db.batch()', async () => {
    // regression: storeDomains awaited one INSERT per domain.
    const sqlite = openSqlite();
    const { d1, runs, batchCount } = makeSqliteD1(sqlite);
    const svc = new D1Service(d1, 'mainnet');
    const domains = ['a.eth', 'b.eth', 'c.eth'].map(v2Domain);

    expect(await svc.storeDomains(domains)).toBe(3);
    expect(batchCount()).toBe(1);
    expect(runs).toHaveLength(0);
    expect(rowCount(sqlite, 'domains', 'mainnet')).toBe(3);

    // A re-store still bumps sync_version (the subselect runs inside the batch).
    await svc.storeDomains(domains);
    const versions = sqlite.prepare('SELECT sync_version AS v FROM domains').all() as Array<{ v: number }>;
    expect(versions.map((r) => Number(r.v))).toEqual([2, 2, 2]);
  });

  it('storeHierarchy replaces the hierarchy in a single db.batch()', async () => {
    const sqlite = openSqlite();
    const { d1, runs, batchCount } = makeSqliteD1(sqlite);
    const svc = new D1Service(d1, 'mainnet');
    seedHierarchy(sqlite, 'mainnet', 'fox.eth', 'stale.fox.eth', 3, Date.now());

    await svc.storeHierarchy('fox.eth', [
      { name: 'eth', owner: ZERO, resolver: ZERO, level: 1 },
      { name: 'fox.eth', owner: OWNER, resolver: ZERO, level: 2 },
    ]);

    expect(batchCount()).toBe(1);
    expect(runs).toHaveLength(0);
    expect((await svc.getHierarchy('fox.eth')).map((r) => r.name)).toEqual(['eth', 'fox.eth']);
  });
});

// ---- (c) sync_status is not rewritten on every sync -------------------------

describe.skipIf(!hasSqlite)('updateSyncStatus write throttling', () => {
  const T0 = Date.UTC(2026, 8, 1);

  function setup() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const sqlite = openSqlite();
    const { d1, runs } = makeSqliteD1(sqlite);
    const svc = new D1Service(d1, 'mainnet');
    const writes = () => runs.filter((sql) => sql.includes('sync_status')).length;
    const row = (operation: string) => sqlite
      .prepare('SELECT * FROM sync_status WHERE network = ?1 AND operation = ?2')
      .get('mainnet', operation) as Record<string, number | string | null>;
    return { svc, writes, row };
  }

  it('writes once per interval while the outcome is unchanged, and keeps the counts', async () => {
    // regression: every sync rewrote the same (network, operation) row.
    const { svc, writes, row } = setup();

    for (let i = 0; i < 10; i++) await svc.updateSyncStatus('domains', true);
    expect(writes()).toBe(1);
    expect(Number(row('domains').sync_count)).toBe(1);

    vi.setSystemTime(T0 + SYNC_STATUS_WRITE_INTERVAL_MS);
    await svc.updateSyncStatus('domains', true);
    expect(writes()).toBe(2);
    expect(Number(row('domains').sync_count)).toBe(11); // the 9 held calls are added
    expect(Number(row('domains').last_sync)).toBe(T0 + SYNC_STATUS_WRITE_INTERVAL_MS);
    expect(Number(row('domains').last_successful_sync)).toBe(T0 + SYNC_STATUS_WRITE_INTERVAL_MS);
  });

  it('writes at once when the outcome flips, with the held counts', async () => {
    const { svc, writes, row } = setup();

    await svc.updateSyncStatus('migration', true); // written
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * 1000);
      await svc.updateSyncStatus('migration', true); // held
    }
    vi.setSystemTime(T0 + 4000);
    await svc.updateSyncStatus('migration', false, 'indexer down');

    expect(writes()).toBe(2);
    const r = row('migration');
    expect(Number(r.sync_count)).toBe(5);
    expect(Number(r.error_count)).toBe(1);
    expect(r.last_error).toBe('indexer down');
    expect(Number(r.last_successful_sync)).toBe(T0 + 3000); // the last held success
    expect(Number(r.last_sync)).toBe(T0 + 4000);

    vi.setSystemTime(T0 + 5000);
    await svc.updateSyncStatus('migration', true); // flips back → written, error cleared
    expect(writes()).toBe(3);
    expect(row('migration').last_error).toBeNull();
  });

  it('concurrent calls in one isolate produce one write', async () => {
    const { svc, writes, row } = setup();
    await Promise.all(Array.from({ length: 20 }, () => svc.updateSyncStatus('hierarchy', true)));
    expect(writes()).toBe(1);
    expect(Number(row('hierarchy').sync_count)).toBe(1);
  });
});

// ---- (d) rows older than the read max age are a miss ------------------------

describe.skipIf(!hasSqlite)('D1 reads treat rows older than the read max age as a miss', () => {
  const STALE = () => Date.now() - D1_READ_MAX_AGE_MS - DAY;
  const FRESH = () => Date.now() - DAY;

  function seeded() {
    const sqlite = openSqlite();
    seedDomain(sqlite, 'mainnet', 'stale.eth', STALE());
    seedDomain(sqlite, 'mainnet', 'fresh.eth', FRESH());
    seedMigration(sqlite, 'mainnet', 'stale.eth', STALE());
    seedMigration(sqlite, 'mainnet', 'fresh.eth', FRESH());
    seedHierarchy(sqlite, 'mainnet', 'stale.eth', 'stale.eth', 2, STALE());
    seedHierarchy(sqlite, 'mainnet', 'fresh.eth', 'fresh.eth', 2, FRESH());
    return sqlite;
  }

  it('getDomain, getDomainById, getMigrationStatus, getHierarchy and getDomains skip stale rows', async () => {
    // regression (WEB-1551): reads ignored last_updated, so a row written
    // months ago was served as current.
    const svc = new D1Service(makeSqliteD1(seeded()).d1, 'mainnet');

    expect(await svc.getDomain('stale.eth')).toBeNull();
    expect(await svc.getDomainById(namehash('stale.eth'))).toBeNull();
    expect(await svc.getMigrationStatus('stale.eth')).toBeNull();
    expect(await svc.getHierarchy('stale.eth')).toEqual([]);
    expect((await svc.getDomains(['stale.eth', 'fresh.eth'])).map((d) => d.name)).toEqual(['fresh.eth']);

    expect((await svc.getDomain('fresh.eth'))?.name).toBe('fresh.eth');
    expect((await svc.getDomainById(namehash('fresh.eth')))?.name).toBe('fresh.eth');
    expect((await svc.getMigrationStatus('fresh.eth'))?.status).toBe('native');
    expect((await svc.getHierarchy('fresh.eth')).map((r) => r.name)).toEqual(['fresh.eth']);
  });

  it('honors a configured read max age', async () => {
    const svc = new D1Service(makeSqliteD1(seeded()).d1, 'mainnet', { readMaxAgeMs: DAY / 2 });
    expect(await svc.getDomain('fresh.eth')).toBeNull(); // 1 day old > 12 h
  });

  it('the last-resort tier does not serve a stale row when every source fails', async () => {
    const sqlite = seeded();
    const outage = () => ({
      getDomainMetadata: vi.fn().mockRejectedValue(new UpstreamError('all sources down')),
    });

    const svc = makeService(makeSqliteD1(sqlite).d1, { network: 'mainnet', indexerV2ApiVersion: 'v1' });
    (svc as unknown as { fallback: unknown }).fallback = outage();
    await expect(svc.getMetadata('mainnet', 'registry', 'stale.eth', 'https://meta.test'))
      .rejects.toBeInstanceOf(UpstreamError);
    expect((await svc.getMetadata('mainnet', 'registry', 'fresh.eth', 'https://meta.test')).name)
      .toBe('fresh.eth');

    // d1ReadMaxAgeMs reaches the D1 tier.
    const strict = makeService(makeSqliteD1(sqlite).d1, {
      network: 'mainnet', indexerV2ApiVersion: 'v1', d1ReadMaxAgeMs: DAY / 2,
    });
    (strict as unknown as { fallback: unknown }).fallback = outage();
    await expect(strict.getMetadata('mainnet', 'registry', 'fresh.eth', 'https://meta.test'))
      .rejects.toBeInstanceOf(UpstreamError);
  });

  it('D1_READ_MAX_AGE_SECS reaches the Worker\'s D1 reads', async () => {
    // A 30-minute-old row is inside sync's 1 h stale threshold, so a request
    // does not rewrite it, unless the env override makes the read a miss.
    const run = async (env: Record<string, unknown>) => {
      const sqlite = openSqlite();
      const seededAt = Date.now() - 30 * 60 * 1000;
      seedDomain(sqlite, 'sepolia', 'sub.fox.eth', seededAt);
      stubIndexer();
      const app = await loadApp();
      const { ctx, drain } = makeCtx();
      const res = await app.request(
        '/sepolia/registry/sub.fox.eth', undefined,
        makeEnv({ DB: makeSqliteD1(sqlite).d1, ...env }), ctx as unknown as ExecutionContext,
      );
      expect(res.status).toBe(200);
      await drain();
      const row = sqlite.prepare('SELECT last_updated FROM domains WHERE name = ?1').get('sub.fox.eth') as
        { last_updated: number };
      return Number(row.last_updated) !== seededAt; // rewritten?
    };

    expect(await run({})).toBe(false);
    expect(await run({ D1_READ_MAX_AGE_SECS: '600' })).toBe(true);
  });

  // ---- envSecsToMs guard-gap regressions on the D1 read path ---------------

  // Prove D1 freshness via forced upstream outage: when the indexer is down,
  // the only data source is D1. A row older than the 7-day default but younger
  // than 10 years discriminates the cap from its fallback.
  const readFreshness = async (env: Record<string, unknown>) => {
    const sqlite = openSqlite();
    // 8-day-old row: older than 7-day default, younger than 10-year max.
    seedDomain(sqlite, 'sepolia', 'sub.fox.eth', Date.now() - 8 * DAY);
    // Force indexer outage: every fetch for the indexer throws.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith('https://zigens.test/') || String(url).startsWith('https://api.'))
        throw new Error('indexer outage');
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    try {
      const app = await loadApp();
      const { ctx, drain } = makeCtx();
      const res = await app.request(
        '/sepolia/registry/sub.fox.eth', undefined,
        makeEnv({ DB: makeSqliteD1(sqlite).d1, ...env }), ctx as unknown as ExecutionContext,
      );
      await drain();
      return res.status;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('serves from D1 at the exact operational maximum (10 years) under upstream outage', async () => {
    // 8-day row < 10-year max → D1 serves → HTTP 200.
    // A >= MAX_ENV_SECS mutant would reject the max, fall back to 7-day default,
    // and the 8-day row would be stale → outage → 503. Kills the mutant.
    expect(await readFreshness({ D1_READ_MAX_AGE_SECS: String(MAX_ENV_SECS) })).toBe(200);
  });

  it('rejects max+1 for D1 read freshness under upstream outage (falls back to 7-day default, outage → 503)', async () => {
    // Cap rejects 315360001 → 7-day default. 8-day row > 7 days → stale → outage → 503.
    expect(await readFreshness({ D1_READ_MAX_AGE_SECS: String(MAX_PLUS_ONE) })).toBe(503);
  });

  it('rejects an unsafe-integer digit string for D1 read freshness under upstream outage (outage → 503)', async () => {
    // '9'.repeat(16) → unsafe int → rejected → 7-day default → stale → outage → 503.
    expect(await readFreshness({ D1_READ_MAX_AGE_SECS: '9'.repeat(16) })).toBe(503);
  });

  it('rejects safe seconds / unsafe ms for D1 read freshness under upstream outage (outage → 503)', async () => {
    expect(await readFreshness({ D1_READ_MAX_AGE_SECS: String(SAFE_SECS_UNSAFE_MS) })).toBe(503);
  });
});

// ---- (e) daily retention cron -----------------------------------------------

describe.skipIf(!hasSqlite)('scheduled D1 retention', () => {
  const controller = { cron: '17 4 * * *', scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController;

  function seeded(ages: { old: number; fresh: number }) {
    const sqlite = openSqlite();
    for (const network of ['mainnet', 'sepolia']) {
      seedDomain(sqlite, network, 'old.eth', Date.now() - ages.old);
      seedDomain(sqlite, network, 'fresh.eth', Date.now() - ages.fresh);
      seedMigration(sqlite, network, 'old.eth', Date.now() - ages.old);
      seedMigration(sqlite, network, 'fresh.eth', Date.now() - ages.fresh);
      seedHierarchy(sqlite, network, 'old.eth', 'old.eth', 2, Date.now() - ages.old);
      seedHierarchy(sqlite, network, 'fresh.eth', 'fresh.eth', 2, Date.now() - ages.fresh);
    }
    sqlite.prepare(
      `INSERT INTO sync_status (network, operation, last_sync, last_successful_sync) VALUES ('mainnet', 'domains', 1, 1)`,
    ).run();
    return sqlite;
  }

  function names(sqlite: SqliteDb, table: string) {
    return (sqlite.prepare(`SELECT network || ':' || name AS k FROM ${table} ORDER BY k`).all() as Array<{ k: string }>)
      .map((r) => r.k);
  }

  it('the Worker\'s scheduled handler deletes rows past retention, keeps fresh ones, and logs the counts', async () => {
    const sqlite = seeded({ old: D1_RETENTION_MS + DAY, fresh: D1_RETENTION_MS - DAY });
    const app = await loadApp();
    const log = vi.mocked(console.log);

    await app.scheduled(controller, makeEnv({ DB: makeSqliteD1(sqlite).d1 }) as never, makeCtx().ctx as never);

    for (const table of ['domains', 'migration_status', 'registry_hierarchy']) {
      expect(names(sqlite, table)).toEqual(['mainnet:fresh.eth', 'sepolia:fresh.eth']);
    }
    expect(rowCount(sqlite, 'sync_status')).toBe(1); // not a retained table

    // One JSON line per network, so it stays parseable behind the redacting console.
    const entries = log.mock.calls
      .map(([entry]) => entry)
      .filter((entry): entry is string => typeof entry === 'string' && entry.includes('"[d1-retention]'))
      .map((entry) => JSON.parse(entry) as { message: string; network: string });
    expect(entries).toEqual(['mainnet', 'sepolia'].map((network) => expect.objectContaining({
      network,
      deleted: { domains: 1, migration_status: 1, registry_hierarchy: 1 },
      remaining: { domains: 1, migration_status: 1, registry_hierarchy: 1 },
      complete: true,
    })));
  });

  it('honors D1_RETENTION_SECS', async () => {
    const sqlite = seeded({ old: 10 * DAY, fresh: 2 * DAY });
    const app = await loadApp();

    await app.scheduled(
      controller,
      makeEnv({ DB: makeSqliteD1(sqlite).d1, D1_RETENTION_SECS: String(5 * 24 * 60 * 60) }) as never,
      makeCtx().ctx as never,
    );

    expect(names(sqlite, 'domains')).toEqual(['mainnet:fresh.eth', 'sepolia:fresh.eth']);
  });

  it.each(['30d', '1e6', String(60 * 60), '-5'])(
    'ignores a D1_RETENTION_SECS of %j (not whole seconds, or under a day) and keeps the default',
    async (value) => {
      const sqlite = seeded({ old: 10 * DAY, fresh: 2 * DAY });
      const app = await loadApp();

      await app.scheduled(
        controller,
        makeEnv({ DB: makeSqliteD1(sqlite).d1, D1_RETENTION_SECS: value }) as never,
        makeCtx().ctx as never,
      );

      // Default 30 days: both rows are kept.
      expect(names(sqlite, 'domains')).toEqual(['mainnet:fresh.eth', 'mainnet:old.eth', 'sepolia:fresh.eth', 'sepolia:old.eth']);
      expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('ignoring D1_RETENTION_SECS'));
    },
  );

  it('keeps the default export working as the Hono app', async () => {
    const app = await loadApp();
    expect(typeof app.scheduled).toBe('function');
    expect((await app.request('/')).status).toBe(200);
  });

  it('deletes a backlog larger than one chunk', async () => {
    const sqlite = openSqlite();
    const old = Date.now() - D1_RETENTION_MS - DAY;
    sqlite.exec('BEGIN');
    for (let i = 0; i <= D1_CLEANUP_CHUNK_ROWS; i++) seedDomain(sqlite, 'mainnet', `n${i}.eth`, old);
    sqlite.exec('COMMIT');
    seedDomain(sqlite, 'mainnet', 'fresh.eth', Date.now());
    const { d1, runs } = makeSqliteD1(sqlite);

    const result = await new D1Service(d1, 'mainnet').cleanup();

    expect(result).toEqual({
      deleted: { domains: D1_CLEANUP_CHUNK_ROWS + 1, migration_status: 0, registry_hierarchy: 0 },
      complete: true,
    });
    expect(runs.filter((sql) => sql.includes('DELETE FROM domains'))).toHaveLength(2);
    expect(names(sqlite, 'domains')).toEqual(['mainnet:fresh.eth']);
  });

  it('stops at the chunk cap and reports the run incomplete', async () => {
    // A D1 that always reports a full chunk deleted.
    const deletes: string[] = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => {
            deletes.push(sql);
            return { success: true, results: [], meta: { changes: D1_CLEANUP_CHUNK_ROWS } };
          },
        }),
      }),
    } as unknown as D1Database;

    const result = await new D1Service(d1, 'mainnet').cleanup();

    expect(result.complete).toBe(false);
    expect(deletes).toHaveLength(3 * D1_CLEANUP_MAX_CHUNKS);
    expect(result.deleted.domains).toBe(D1_CLEANUP_MAX_CHUNKS * D1_CLEANUP_CHUNK_ROWS);
  });
});
