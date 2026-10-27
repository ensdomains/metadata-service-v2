import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { createMockKV, createMockR2 } from './mocks/hono-env';
import { namehash } from '../src/utils/ens';
import { D1Service } from '../src/services/d1';
import { MIGRATION_STATUS, type MigrationStatus, type NetworkName } from '../src/types';
import type { MetadataServiceConfig, BlockchainEnvironment } from '../src/services/metadata';

// Regression tests for the POST /webhook warming path (src/index.ts) and the
// D1 migration_status persistence it drives. The webhook tests exercise the
// REAL Hono app (routing, WebhookService validation, targetNetworks fan-out,
// per-network warm/persist loop); only the leaf services are faked so nothing
// leaves the process.

// node:sqlite is not on vite's builtin allowlist; load it at runtime. A real
// SQL engine matters here: the behavior under test (INSERT OR REPLACE +
// COALESCE subselects in D1Service) lives in SQL, not JS, so a vi.fn() fake
// could not pin it.
//
// node:sqlite only exists on newer Node lines (absent on Node 20) — feature-
// detect and SKIP the real-SQL suites where it's missing so older runtimes
// stay green; any modern leg (Node 22+, local dev) still pins the SQL.
const nodeRequire = createRequire(import.meta.url);
let DatabaseSyncImpl: typeof import('node:sqlite').DatabaseSync | null = null;
try {
  ({ DatabaseSync: DatabaseSyncImpl } = nodeRequire('node:sqlite') as typeof import('node:sqlite'));
} catch {
  console.warn('[webhook-warming.test] node:sqlite unavailable on this Node — skipping real-SQL D1 suites');
}
const hasSqlite = DatabaseSyncImpl !== null;
type SqliteDb = InstanceType<NonNullable<typeof DatabaseSyncImpl>>;
function openSqlite(): SqliteDb {
  if (!DatabaseSyncImpl) throw new Error('node:sqlite unavailable (suite should have been skipped)');
  return new DatabaseSyncImpl(':memory:');
}

// Shared state for the hoisted vi.mock factories below. mode 'real' delegates
// to the genuine MetadataService (full fallback chain); mode 'record' replaces
// classify/persist with per-network recorders.
const warmState = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'record',
  classify: [] as Array<{ network: string; name: string; strict: boolean }>,
  persist: [] as Array<{ network: string; name: string; status: string }>,
  warm: [] as Array<{ network: string; name: string }>,
}));

// Mock rasterize (WASM imports break under vite-node) — mirrors test/index.test.ts.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

// Image-warming recorder. Warming runs AFTER the classify + persist steps under
// test, so an inert fake keeps the tests hermetic while recording the target
// network. Real signature: (svgCacheKv, storageManager, imageService, avatarService, network, bucket).
vi.mock('../src/services/image-cache', () => ({
  ImageCacheService: class {
    private net: string;
    constructor(_kv: unknown, _sm: unknown, _img: unknown, _av: unknown, network: string) {
      this.net = network;
    }
    async getImage(name: string) {
      warmState.warm.push({ network: this.net, name });
      return { svg: '<svg/>', cacheStatus: 'MISS', ttlConfig: { softTtl: 60, hardTtl: 3600 } };
    }
  },
}));

// MetadataService wrapper: real behavior by default; in 'record' mode the
// classify/persist entry points become recorders, with mainnet throwing
// NotFoundError (the existence gate: the name only resolves on sepolia).
vi.mock('../src/services/metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/metadata')>();
  const { NotFoundError } = await import('../src/services/errors');
  class MetadataService extends actual.MetadataService {
    private recorderNetwork: string;
    constructor(config: MetadataServiceConfig, kv: KVNamespace, env: BlockchainEnvironment, db?: D1Database) {
      super(config, kv, env, db);
      this.recorderNetwork = config.network ?? 'mainnet';
    }
    async resolveStatusForImage(
      network: NetworkName,
      name: string,
      opts?: { strict?: boolean },
    ): Promise<MigrationStatus> {
      if (warmState.mode === 'real') return super.resolveStatusForImage(network, name, opts);
      warmState.classify.push({ network, name, strict: opts?.strict === true });
      if (network === 'mainnet') throw new NotFoundError(`${name} does not exist on mainnet`);
      return MIGRATION_STATUS.UNMIGRATED;
    }
    async recordMigrationStatus(
      name: string,
      status: MigrationStatus,
      data?: { owner?: string; expirationDate?: string },
    ): Promise<void> {
      if (warmState.mode === 'real') return super.recordMigrationStatus(name, status, data);
      warmState.persist.push({ network: this.recorderNetwork, name, status });
    }
  }
  return { ...actual, MetadataService };
});

// ---- helpers ---------------------------------------------------------------

// Minimal D1Database shim backed by real SQLite (the subset D1Service uses).
function makeSqliteD1(db: SqliteDb): D1Database {
  const stmt = (sql: string, params: unknown[] = []): unknown => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    run: async () => ({ success: true, results: [], meta: db.prepare(sql).run(...(params as never[])) }),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])), success: true, meta: {} }),
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

// Exact migration_status schema from migrations/002_network_scoping.sql.
const MIGRATION_STATUS_SCHEMA = `
CREATE TABLE migration_status (
  network TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  expiration_date TEXT,
  migration_date TEXT,
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (network, id)
);
CREATE UNIQUE INDEX idx_migration_network_name ON migration_status(network, name);
`;

function webhookEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'NameRenewed',
    protocol: 'v2',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    contract_address: '0xdef',
    name: 'fox.eth',
    namehash: namehash('fox.eth'),
    data: '{}',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

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
    WEBHOOK_ALLOW_UNAUTHENTICATED: 'true', // dev acceptance path — no signature needed
    RATE_LIMIT_DISABLED: 'true',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

// Fresh app per test: src/index.ts caches services per network at module level,
// so a re-import (after resetModules) keeps the tests order-independent.
async function loadApp() {
  vi.resetModules();
  return (await import('../src/index')).default;
}

// POST the event to the real /webhook route, capturing waitUntil tasks so the
// background warming pass can be awaited deterministically.
async function postWebhook(
  app: Awaited<ReturnType<typeof loadApp>>,
  event: Record<string, unknown>,
  env: Record<string, unknown>,
) {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => {},
  };
  const res = await app.request(
    '/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    },
    env,
    ctx as unknown as ExecutionContext,
  );
  return { res, drain: () => Promise.allSettled(tasks) };
}

beforeEach(() => {
  warmState.mode = 'real';
  warmState.classify.length = 0;
  warmState.persist.length = 0;
  warmState.warm.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- tests -----------------------------------------------------------------

describe.skipIf(!hasSqlite)('webhook warming vs transient indexer outage', () => {
  it(
    'must not overwrite a correct D1 native row while classification upstreams are down',
    async () => {
      // regression: webhook warming persisted the error-fallback 'unmigrated' to
      // D1 during an outage, clobbering a correct 'native' last-resort row.
      const db = openSqlite();
      db.exec(MIGRATION_STATUS_SCHEMA);
      // Previously-correct row: fox.eth is native-v2 on sepolia.
      const seededAt = Date.now() - 10 * 60 * 1000; // within sync's 1h staleThreshold
      db.prepare(
        `INSERT INTO migration_status (network, id, name, status, owner, expiration_date, migration_date, last_updated, sync_version)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, 1)`,
      ).run('sepolia', namehash('fox.eth'), 'fox.eth', 'native', seededAt);

      const app = await loadApp();
      const env = makeEnv({ DB: makeSqliteD1(db) });

      // Transient zigens/RPC outage: every outbound request fails.
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED (simulated outage)');
      }));

      const { res, drain } = await postWebhook(app, webhookEvent(), env);
      expect(res.status).toBe(200); // webhook accepted → warming pass scheduled
      await drain();

      // The durable last-resort row must survive the blip untouched.
      const after = db
        .prepare('SELECT status, last_updated FROM migration_status WHERE network = ?1 AND name = ?2')
        .get('sepolia', 'fox.eth') as { status: string; last_updated: number };
      expect(after.status).toBe('native');
      expect(after.last_updated).toBe(seededAt); // no rewrite at all (would defer re-sync)
    },
    60_000, // the real fallback chain burns its retry backoff before giving up
  );
});

describe('webhook protocol→network fan-out (targetNetworks)', () => {
  it('v1-protocol event for a sepolia-only name attempts both networks, persists/warms only sepolia', async () => {
    // regression: protocol:'v1' was mapped to networks whose indexer DIALECT is
    // v1 (mainnet only), so a legacy-sepolia event was classified/persisted on
    // the wrong chain and sepolia got neither the D1 update nor the warm.
    warmState.mode = 'record';
    const app = await loadApp();
    const env = makeEnv(); // no DB needed: persistence is recorded, not written

    // zigens (a v2-dialect indexer) emits protocol:'v1' for legacy activity on
    // ITS chain too — the chain cannot be derived from the payload.
    const event = webhookEvent({
      protocol: 'v1',
      contract_address: '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85',
      name: 'test123.eth', // exists only on legacy sepolia in this scenario
      namehash: '0x1234',
    });

    const { res, drain } = await postWebhook(app, event, env);
    expect(res.status).toBe(200);
    await drain();

    // Both networks attempted (a v1 event could concern ANY chain)…
    expect(warmState.classify.map((c) => c.network).sort()).toEqual(['mainnet', 'sepolia']);
    // regression: the webhook call site must classify in STRICT mode — a
    // degraded badge default must throw here, never be persisted to D1.
    expect(warmState.classify.every((c) => c.strict)).toBe(true);
    // …but the existence gate (NotFoundError on mainnet) skips persist + warm
    // there, so the wrong chain gets no D1 pollution and no image warm.
    expect(warmState.persist).toEqual([
      { network: 'sepolia', name: 'test123.eth', status: MIGRATION_STATUS.UNMIGRATED },
    ]);
    expect(warmState.warm.map((w) => w.network)).toEqual(['sepolia']);
  });
});

describe('webhook events for names this service never serves', () => {
  it.each([
    ['deeper than MAX_NAME_LABELS', `${Array.from({ length: 32 }, (_, i) => `l${i}`).join('.')}.eth`],
    ['longer than 255 characters', `${'a'.repeat(300)}.eth`],
  ])('acknowledges a name %s without invalidating or warming anything', async (_label, name) => {
    warmState.mode = 'record';
    const app = await loadApp();
    const env = makeEnv();

    const { res, drain } = await postWebhook(app, webhookEvent({ name, namehash: '0x1234' }), env);
    await drain();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ignored', processed: false });
    expect(warmState.classify).toEqual([]);
    expect(warmState.warm).toEqual([]);
    expect(vi.mocked(env.METADATA_CACHE.delete)).not.toHaveBeenCalled();
  });

  it.each([42, 'noTld', 'a..eth'])('still rejects a malformed name (%j) with 400', async (name) => {
    const app = await loadApp();
    const { res } = await postWebhook(app, webhookEvent({ name }), makeEnv());
    expect(res.status).toBe(400);
  });
});

describe('webhook body size cap', () => {
  it('413s an event over MAX_WEBHOOK_BODY_BYTES and warms nothing', async () => {
    warmState.mode = 'record';
    const app = await loadApp();
    const { MAX_WEBHOOK_BODY_BYTES } = await import('../src/services/webhook');

    const { res, drain } = await postWebhook(
      app,
      webhookEvent({ name: 'test123.eth', data: ' '.repeat(MAX_WEBHOOK_BODY_BYTES) }),
      makeEnv(),
    );
    expect(res.status).toBe(413);
    await drain();
    expect(warmState.classify).toEqual([]);
    expect(warmState.persist).toEqual([]);
    expect(warmState.warm).toEqual([]);
  });

  // The route clones the request (to parse it for warming) before the service
  // reads it. A cloned body is a tee: its source is released only once both
  // branches are cancelled, so on a 413 the route must cancel the clone it will
  // never read, as the service cancels its own branch.
  const CHUNK = new Uint8Array(16 * 1024).fill(0x20);

  // An endless request body, recording how many chunks were pulled from it and
  // whether it was released (cancelled).
  function endlessBody() {
    const source = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { source.pulled++; controller.enqueue(CHUNK); },
      cancel() { source.cancelled = true; },
    });
    return { stream, source };
  }

  async function postBody(
    app: Awaited<ReturnType<typeof loadApp>>,
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>,
  ) {
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => {} };
    const req = new Request('http://localhost/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, duplex: 'half',
    } as RequestInit);
    const res = await app.request(req, undefined, makeEnv(), ctx as unknown as ExecutionContext);
    await Promise.allSettled(tasks);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the cancellations settle
    return res;
  }

  it('413s a streamed body with no Content-Length at the cap and releases it, clone included', async () => {
    warmState.mode = 'record';
    const app = await loadApp();
    const { MAX_WEBHOOK_BODY_BYTES } = await import('../src/services/webhook');
    const { stream, source } = endlessBody();

    const res = await postBody(app, stream, {});
    expect(res.status).toBe(413);
    expect(source.pulled * CHUNK.byteLength).toBeLessThanOrEqual(MAX_WEBHOOK_BODY_BYTES + 3 * CHUNK.byteLength);
    expect(source.cancelled).toBe(true);
    expect(warmState.warm).toEqual([]);
  });

  it('413s a body whose Content-Length is over the cap without reading it, and releases it', async () => {
    warmState.mode = 'record';
    const app = await loadApp();
    const { MAX_WEBHOOK_BODY_BYTES } = await import('../src/services/webhook');
    const { stream, source } = endlessBody();

    const res = await postBody(app, stream, { 'Content-Length': String(MAX_WEBHOOK_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(source.pulled).toBeLessThanOrEqual(2); // the streams' own read-ahead, nothing more
    expect(source.cancelled).toBe(true);
    expect(warmState.warm).toEqual([]);
  });
});

describe.skipIf(!hasSqlite)('D1 storeMigrationStatus — partial (webhook-shaped) writes', () => {
  const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  function seededD1() {
    const sqlite = openSqlite();
    sqlite.exec(MIGRATION_STATUS_SCHEMA);
    return { sqlite, d1: new D1Service(makeSqliteD1(sqlite), 'sepolia') };
  }

  it('a status-only write preserves previously-synced owner/expiration/migration dates', async () => {
    // regression: INSERT OR REPLACE rewrote the whole row, so the webhook's
    // data-less recordMigrationStatus nulled owner/expiration_date that a
    // fuller sync had stored — degrading the D1 last-resort tier for outages.
    const { d1 } = seededD1();

    // A fuller sync (SyncService.syncMigrationStatus) stored the row with data…
    await d1.storeMigrationStatus('vitalik.eth', MIGRATION_STATUS.UNMIGRATED, {
      owner: OWNER,
      expirationDate: '2030-05-03T00:00:00.000Z',
      migrationDate: '2026-06-01T00:00:00.000Z',
    });
    const before = await d1.getMigrationStatus('vitalik.eth');
    expect(before?.owner).toBe(OWNER);
    expect(before?.expiration_date).toBe('2030-05-03T00:00:00.000Z');

    // …then the webhook path writes status only: the exact call shape of the
    // warming loop (MetadataService.recordMigrationStatus with NO data arg).
    const { MetadataService } = await vi.importActual<typeof import('../src/services/metadata')>(
      '../src/services/metadata',
    );
    const svc = Object.create(MetadataService.prototype) as InstanceType<typeof MetadataService>;
    (svc as unknown as { d1: D1Service }).d1 = d1;
    await svc.recordMigrationStatus('vitalik.eth', MIGRATION_STATUS.MIGRATED);

    const after = await d1.getMigrationStatus('vitalik.eth');
    // The write itself happened (recordMigrationStatus swallows errors, so prove
    // success rather than a silent no-op):
    expect(after?.status).toBe(MIGRATION_STATUS.MIGRATED);
    expect(Number(after?.sync_version)).toBe(Number(before?.sync_version) + 1);
    // COALESCE preserved everything the webhook didn't know:
    expect(after?.owner).toBe(OWNER);
    expect(after?.expiration_date).toBe('2030-05-03T00:00:00.000Z');
    expect(after?.migration_date).toBe('2026-06-01T00:00:00.000Z');
  });

  it('an explicit data update still overwrites the stored values', async () => {
    // guard: COALESCE must only fill ABSENT inputs — supplied values win.
    const { d1 } = seededD1();
    await d1.storeMigrationStatus('vitalik.eth', MIGRATION_STATUS.UNMIGRATED, {
      owner: OWNER,
      expirationDate: '2030-05-03T00:00:00.000Z',
      migrationDate: '2026-06-01T00:00:00.000Z',
    });

    const NEW_OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
    await d1.storeMigrationStatus('vitalik.eth', MIGRATION_STATUS.MIGRATED, {
      owner: NEW_OWNER,
      expirationDate: '2032-01-01T00:00:00.000Z',
    });

    const after = await d1.getMigrationStatus('vitalik.eth');
    expect(after?.status).toBe(MIGRATION_STATUS.MIGRATED);
    expect(after?.owner).toBe(NEW_OWNER);
    expect(after?.expiration_date).toBe('2032-01-01T00:00:00.000Z');
    // The field NOT supplied in the update is still preserved, not nulled.
    expect(after?.migration_date).toBe('2026-06-01T00:00:00.000Z');
  });
});
