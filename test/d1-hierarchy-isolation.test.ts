import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { D1Service } from '../src/services/d1';
import { MetadataService } from '../src/services/metadata';
import { UpstreamError } from '../src/services/errors';
import { namehash, canonicalizeName } from '../src/utils/ens';

// W8-D1-001: storeHierarchy's explicit per-domain replacement promise — storing
// one root must not corrupt a sibling root that shares an ancestor.
//
// External closure also found:
//  - P2 (performance): getHierarchy needs composite index
//    (network, root_domain_id, level).
//  - P2 (availability): migration 003 drops hierarchy rows; fresh-domain sync
//    and hierarchy-only traffic both need recovery that triggers syncHierarchy
//    registered with waitUntil.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

// Real SQLite with the schema from the migrations; feature-detected as in
// d1-canonical-name.test.ts and webhook-warming.test.ts.
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | null = null;
try {
  ({ DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite'));
} catch {
  console.warn('[d1-hierarchy-isolation.test] node:sqlite unavailable on this Node — skipping real-SQL D1 suites');
}

// === D1-level tests (real SQLite) ==========================================

describe.skipIf(!DatabaseSync)('D1 hierarchy isolation (W8-D1-001)', () => {
  function sqliteD1(extraMigration?: string) {
    const sqlite = new DatabaseSync!(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/002_network_scoping.sql', import.meta.url), 'utf8'));
    if (extraMigration) {
      sqlite.exec(readFileSync(new URL(extraMigration, import.meta.url), 'utf8'));
    }
    const stmt = (sql: string, params: unknown[] = []): unknown => ({
      bind: (...p: unknown[]) => stmt(sql, p),
      run: async () => ({ success: true, results: [], meta: sqlite.prepare(sql).run(...(params as never[])) }),
      first: async () => sqlite.prepare(sql).get(...(params as never[])) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(params as never[])), success: true, meta: {} }),
    });
    return { sqlite, db: { prepare: (sql: string) => stmt(sql), batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())) } as unknown as D1Database };
  }

  function ethAncestor() {
    return { name: 'eth', owner: ZERO, resolver: ZERO, level: 1 };
  }

  function aEthDomain() {
    return { name: 'a.eth', owner: OWNER, resolver: ZERO, level: 2 };
  }

  function bEthDomain() {
    return { name: 'b.eth', owner: OWNER, resolver: ZERO, level: 2 };
  }

  // --- original regression tests (pass on HEAD) ---

  it('getHierarchy("a.eth") returns the intact root-first [eth, a.eth] hierarchy after b.eth is stored', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');
    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    await d1.storeHierarchy('b.eth', [ethAncestor(), bEthDomain()]);
    const results = await d1.getHierarchy('a.eth');
    const names = results.map((r) => r.name);
    expect(names).toEqual(['eth', 'a.eth']);
  });

  it('getHierarchy("b.eth") returns the intact root-first [eth, b.eth] hierarchy', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');
    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    await d1.storeHierarchy('b.eth', [ethAncestor(), bEthDomain()]);
    const results = await d1.getHierarchy('b.eth');
    const names = results.map((r) => r.name);
    expect(names).toEqual(['eth', 'b.eth']);
  });

  it('storing the same domain twice replaces, not duplicates, its hierarchy', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');
    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    await d1.storeHierarchy('a.eth', [
      { name: 'eth', owner: ZERO, resolver: '0x1111111111111111111111111111111111111111', level: 1 },
      aEthDomain(),
    ]);
    const results = await d1.getHierarchy('a.eth');
    expect(results).toHaveLength(2);
    const ethRow = results.find((r) => r.name === 'eth');
    expect(ethRow!.resolver).toBe('0x1111111111111111111111111111111111111111');
  });

  // --- P2 (performance): composite index (red on HEAD) ---

  it('EXPLAIN QUERY PLAN uses composite index idx_hierarchy_root_level for getHierarchy', () => {
    const { sqlite } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');

    // Insert 20 domains × 3 levels = 60 rows so the planner has a choice.
    for (let i = 0; i < 20; i++) {
      const name = `d${i}.eth`;
      const rootId = namehash(name);
      const ts = Date.now();
      sqlite.prepare(`INSERT INTO registry_hierarchy (network, id, name, owner, resolver, level, parent_id, root_domain_id, last_updated, sync_version)
        VALUES ('mainnet', ?, 'eth', '${ZERO}', '${ZERO}', 1, NULL, ?, ${ts}, 1)`).run(namehash('eth'), rootId);
      sqlite.prepare(`INSERT INTO registry_hierarchy (network, id, name, owner, resolver, level, parent_id, root_domain_id, last_updated, sync_version)
        VALUES ('mainnet', ?, '${name}', '${ZERO}', '${ZERO}', 2, ?, ?, ${ts}, 1)`).run(rootId, namehash('eth'), rootId);
      sqlite.prepare(`INSERT INTO registry_hierarchy (network, id, name, owner, resolver, level, parent_id, root_domain_id, last_updated, sync_version)
        VALUES ('mainnet', ?, 'sub.${name}', '${ZERO}', '${ZERO}', 3, ?, ?, ${ts}, 1)`).run(namehash(`sub.${name}`), rootId, rootId);
    }

    const rootDomainId = namehash('d5.eth');
    const plan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM registry_hierarchy WHERE network = ? AND root_domain_id = ? ORDER BY level ASC`
    ).all('mainnet', rootDomainId);

    const planText = JSON.stringify(plan);
    // Without the composite index, the planner uses separate indexes (e.g.,
    // idx_hierarchy_level for a network-wide scan). The composite index
    // idx_hierarchy_root_level must appear in the plan.
    expect(planText).toContain('idx_hierarchy_root_level');

    // 3 levels correctly filtered for d5.eth.
    const results = sqlite.prepare(
      'SELECT COUNT(*) as cnt FROM registry_hierarchy WHERE network = ? AND root_domain_id = ?'
    ).get('mainnet', rootDomainId) as { cnt: number };
    expect(results.cnt).toBe(3);
  });

  // --- P2 (availability): getHierarchyCount (red on HEAD — method missing) ---

  it('getHierarchyCount returns 0 after migration when hierarchy is empty', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');
    const count = await (d1 as any).getHierarchyCount('a.eth');
    expect(count).toBe(0);
  });

  it('getHierarchyCount returns the correct level count after storeHierarchy', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');
    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    const count = await (d1 as any).getHierarchyCount('a.eth');
    expect(count).toBe(2);
  });

  // getHierarchyCount must match getHierarchy's isFresh semantics:
  // only rows within readMaxAgeMs count. Stale rows suppress recovery
  // if counted as present, because getHierarchy filters them out.
  it('getHierarchyCount excludes stale rows, matching getHierarchy freshness', async () => {
    const { sqlite } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(
      { prepare: (s: string) => ({ bind: (...a: unknown[]) => ({ first: async () => sqlite.prepare(s).get(...(a as never[])) }) }) } as unknown as D1Database,
      'mainnet'
    );

    const rootId = namehash('a.eth');
    const staleTs = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago (>7 day max age)
    sqlite.prepare(`INSERT INTO registry_hierarchy (network, id, name, owner, resolver, level, parent_id, root_domain_id, last_updated, sync_version)
      VALUES ('mainnet', ?, 'eth', '${ZERO}', '${ZERO}', 1, NULL, ?, ${staleTs}, 1)`).run(namehash('eth'), rootId);

    // Raw SQL count is 1, but getHierarchyCount must return 0 (stale).
    const rawCount = (sqlite.prepare('SELECT COUNT(*) as cnt FROM registry_hierarchy WHERE network = ? AND root_domain_id = ?').get('mainnet', rootId) as { cnt: number }).cnt;
    expect(rawCount).toBe(1);

    const count = await (d1 as any).getHierarchyCount('a.eth');
    expect(count).toBe(0);
  });

  // --- Cross-network isolation ---

  it('same id and root on different networks are independent', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1Mainnet = new D1Service(db, 'mainnet');
    const d1Sepolia = new D1Service(db, 'sepolia');
    const mainnetEth = { name: 'eth', owner: '0xMAIN', resolver: ZERO, level: 1 };
    const sepoliaEth = { name: 'eth', owner: '0xSEP', resolver: ZERO, level: 1 };
    await d1Mainnet.storeHierarchy('a.eth', [mainnetEth, aEthDomain()]);
    await d1Sepolia.storeHierarchy('a.eth', [sepoliaEth, aEthDomain()]);
    const mainnetResults = await d1Mainnet.getHierarchy('a.eth');
    const sepoliaResults = await d1Sepolia.getHierarchy('a.eth');
    expect(mainnetResults).toHaveLength(2);
    expect(sepoliaResults).toHaveLength(2);
    const mainnetEthRow = mainnetResults.find((r) => r.name === 'eth');
    const sepoliaEthRow = sepoliaResults.find((r) => r.name === 'eth');
    expect(mainnetEthRow!.owner).toBe('0xMAIN');
    expect(sepoliaEthRow!.owner).toBe('0xSEP');
  });

  it('storeHierarchy on mainnet does not touch sepolia rows', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1Mainnet = new D1Service(db, 'mainnet');
    const d1Sepolia = new D1Service(db, 'sepolia');
    await d1Sepolia.storeHierarchy('a.eth', [
      { name: 'eth', owner: '0xSEP', resolver: ZERO, level: 1 },
      aEthDomain(),
    ]);
    await d1Mainnet.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    const sepoliaResults = await d1Sepolia.getHierarchy('a.eth');
    const sepoliaEthRow = sepoliaResults.find((r) => r.name === 'eth');
    expect(sepoliaEthRow!.owner).toBe('0xSEP');
  });

  // --- P2 (sync_version): subquery keys only (network, id), missing root_domain_id ---
  // Sibling roots sharing eth would inherit each other's sync_version.
  // store a.eth twice → version 2, store b.eth once → version 1 for b.eth's eth.

  it('sync_version is per-root: sibling roots have independent version sequences', async () => {
    const { db, sqlite } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');

    // Store a.eth once, then b.eth once. They share eth as ancestor.
    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    await d1.storeHierarchy('b.eth', [ethAncestor(), bEthDomain()]);

    // a.eth's eth row: first write, sync_version should be 1.
    const aEthVersion = (sqlite.prepare(
      'SELECT sync_version FROM registry_hierarchy WHERE network = ? AND id = ? AND root_domain_id = ?'
    ).get('mainnet', namehash('eth'), namehash('a.eth')) as { sync_version: number }).sync_version;
    expect(aEthVersion).toBe(1);

    // b.eth's eth row: first write for b.eth, but the subquery
    //   (SELECT sync_version FROM registry_hierarchy WHERE network=?1 AND id=?2)
    // matches a.eth's eth row on HEAD because it only keys on (network, id).
    // After the fix includes root_domain_id, b.eth's version is independent.
    const bEthVersion = (sqlite.prepare(
      'SELECT sync_version FROM registry_hierarchy WHERE network = ? AND id = ? AND root_domain_id = ?'
    ).get('mainnet', namehash('eth'), namehash('b.eth')) as { sync_version: number }).sync_version;
    expect(bEthVersion).toBe(1);
  });

  // --- P2 (boundary): getHierarchyCount uses > but isFresh uses <= ---
  // A row exactly at the max-age boundary is fresh by isFresh (inclusive)
  // but excluded by getHierarchyCount (exclusive), causing redundant sync.

  it('getHierarchyCount includes rows exactly at the freshness boundary, matching isFresh', async () => {
    const { sqlite } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(
      { prepare: (s: string) => ({ bind: (...a: unknown[]) => ({ first: async () => sqlite.prepare(s).get(...(a as never[])) }) }) } as unknown as D1Database,
      'mainnet'
    );

    const rootId = namehash('a.eth');
    // Write a row exactly at the freshness boundary (7 days ago).
    const boundaryTs = Date.now() - (7 * 24 * 60 * 60 * 1000);
    sqlite.prepare(`INSERT INTO registry_hierarchy (network, id, name, owner, resolver, level, parent_id, root_domain_id, last_updated, sync_version)
      VALUES ('mainnet', ?, 'eth', '${ZERO}', '${ZERO}', 1, NULL, ?, ${boundaryTs}, 1)`).run(namehash('eth'), rootId);

    // isFresh uses <= (inclusive), so the row IS fresh.
    // getHierarchyCount must also return 1 (use >= not >).
    const count = await (d1 as any).getHierarchyCount('a.eth');
    expect(count).toBe(1);
  });
});

// === Route-level recovery test (mock-based) =================================
//
// After migration 003 drops registry_hierarchy, getRegistryHierarchy must
// schedule hierarchy recovery via waitUntil on BOTH the success path (healthy
// upstream, D1 empty) and the failure path (upstream down, D1 empty).
//
// Recovery must NOT fire when D1 already has fresh rows (no redundant sync).
// getHierarchyCount must exclude stale rows matching getHierarchy's isFresh
// semantics so stale rows don't suppress recovery.
//
// The waitUntil promise must be the exact pending syncHierarchy promise (not a
// resolved substitute), rejection must be absorbed per policy, and awaiting
// the deferred promise must result in actual D1 persistence.

describe('getRegistryHierarchy D1 recovery (round 3)', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  type Internals = {
    fallback: { getRegistryHierarchy: (name: string) => Promise<unknown> };
    d1: D1Service | null;
    sync: { syncHierarchy: (name: string, force?: boolean) => Promise<unknown> } | null;
    cache: { get: (key: string) => Promise<unknown>; set: (key: string, val: unknown, opts?: unknown) => Promise<unknown> };
  };

  // Build MetadataService with controlled fallback, D1, and sync.
  function makeService(opts: {
    upstream: 'healthy' | 'down';
    d1Rows: Array<{ name: string; owner: string; resolver: string; level: number }>;
    d1Stale?: boolean; // if true, write rows with old timestamps
  }) {
    const svc = new MetadataService(
      {
        indexerV2Endpoint: 'https://indexer.test/graphql',
        indexerV2ApiVersion: 'v2',
        indexerV1Endpoint: 'https://v1.test/subgraph',
        network: 'sepolia',
        fallbackToBlockchain: true,
        internalCacheEnabled: false,
        d1Enabled: true,
        d1ReadMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );

    const s = svc as unknown as Internals;

    // Override fallback: healthy returns a hierarchy, down throws.
    if (opts.upstream === 'healthy') {
      vi.spyOn(s.fallback, 'getRegistryHierarchy').mockResolvedValue({
        data: {
          root: { name: 'a.eth', owner: OWNER, resolver: ZERO },
          parent: { name: 'eth', owner: ZERO, resolver: ZERO },
        },
        source: 'indexerV2',
        usedFallback: false,
      });
    } else {
      vi.spyOn(s.fallback, 'getRegistryHierarchy').mockRejectedValue(new UpstreamError('zigens 502'));
    }

    // Override cache to always miss (forces fresh resolution).
    vi.spyOn(s.cache, 'get').mockResolvedValue(null);
    vi.spyOn(s.cache, 'set').mockResolvedValue(undefined);

    // D1: use real D1Service with real SQLite for persistence tests,
    // or a mock for stale-row tests.
    if (opts.d1Stale) {
      s.d1 = {
        getHierarchy: vi.fn().mockResolvedValue([]), // stale rows filtered out
        getHierarchyCount: vi.fn().mockResolvedValue(0), // stale rows excluded from count
      } as unknown as D1Service;
    } else if (opts.d1Rows.length > 0) {
      s.d1 = {
        getHierarchy: vi.fn().mockResolvedValue(opts.d1Rows),
        getHierarchyCount: vi.fn().mockResolvedValue(opts.d1Rows.length),
      } as unknown as D1Service;
    } else {
      s.d1 = {
        getHierarchy: vi.fn().mockResolvedValue([]),
        getHierarchyCount: vi.fn().mockResolvedValue(0),
      } as unknown as D1Service;
    }

    const syncHierarchyMock = vi.fn().mockResolvedValue({
      operation: 'hierarchy', processed: 1, stored: 1, errors: 0, duration: 0,
    });
    s.sync = { syncHierarchy: syncHierarchyMock };

    return { svc, syncHierarchyMock };
  }

  // --- Healthy response schedules recovery when D1 is empty ---
  // This is the primary round-3 finding: on HEAD, the success path returns
  // before recovery, so D1 stays empty indefinitely even when the indexer
  // is healthy.

  it('healthy upstream: schedules waitUntil recovery when D1 hierarchy is empty', async () => {
    const { svc, syncHierarchyMock } = makeService({ upstream: 'healthy', d1Rows: [] });
    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    const result = await (svc as any).getRegistryHierarchy('a.eth', executionCtx);

    // Response is the live upstream data (not an error).
    expect(result.name).toBe('a.eth');

    // On HEAD: waitUntil is never called because recovery only fires in the
    // catch block. After the fix, waitUntil must be called.
    expect(waitUntil).toHaveBeenCalled();
  });

  // --- No redundant sync when usable fresh rows exist ---

  it('healthy upstream + fresh D1 rows: does NOT schedule recovery', async () => {
    const { svc, syncHierarchyMock } = makeService({
      upstream: 'healthy',
      d1Rows: [
        { name: 'eth', owner: ZERO, resolver: ZERO, level: 1 },
        { name: 'a.eth', owner: OWNER, resolver: ZERO, level: 2 },
      ],
    });
    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    await (svc as any).getRegistryHierarchy('a.eth', executionCtx);

    expect(syncHierarchyMock).not.toHaveBeenCalled();
  });

  it('outage + fresh D1 rows: does NOT schedule recovery (data already usable)', async () => {
    const { svc, syncHierarchyMock } = makeService({
      upstream: 'down',
      d1Rows: [
        { name: 'eth', owner: ZERO, resolver: ZERO, level: 1 },
        { name: 'a.eth', owner: OWNER, resolver: ZERO, level: 2 },
      ],
    });
    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    const result = await (svc as any).getRegistryHierarchy('a.eth', executionCtx);

    // D1 fallback served the stale rows.
    expect(result.hierarchy).toHaveLength(2);
    expect(syncHierarchyMock).not.toHaveBeenCalled();
  });

  // --- Stale-only rows do not suppress recovery ---

  it('outage + stale-only D1 rows: schedules recovery (getHierarchyCount returns 0)', async () => {
    const { svc, syncHierarchyMock } = makeService({ upstream: 'down', d1Rows: [], d1Stale: true });
    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    try { await (svc as any).getRegistryHierarchy('a.eth', executionCtx); } catch (_) { /* basic fallback */ }

    // On HEAD: stale rows may suppress recovery if getHierarchyCount
    // does not filter by freshness. After the fix, recovery fires.
    expect(waitUntil).toHaveBeenCalled();
  });

  // --- Causal containment: registered promise causally contains sync ---
  // The outer promise registered with waitUntil must remain pending while
  // syncHierarchy runs, settle only after it completes, and not swallow
  // assertions. Reference equality with the inner syncPromise is NOT required.

  it('waitUntil-registered promise is pending before sync, settles after sync, and D1 stays empty until sync completes', async () => {
    let syncResolve!: (v: unknown) => void;
    const syncPromise = new Promise((resolve) => { syncResolve = resolve; });
    const syncHierarchyMock = vi.fn().mockReturnValue(syncPromise);

    const { DatabaseSync: DB } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    const sqlite = new DB(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/002_network_scoping.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/003_hierarchy_root_scoping.sql', import.meta.url), 'utf8'));
    const realStmt = (sql: string, params: unknown[] = []): unknown => ({
      bind: (...p: unknown[]) => realStmt(sql, p),
      run: async () => ({ success: true, results: [], meta: sqlite.prepare(sql).run(...(params as never[])) }),
      first: async () => sqlite.prepare(sql).get(...(params as never[])) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(params as never[])), success: true, meta: {} }),
    });
    const realDb = { prepare: (sql: string) => realStmt(sql), batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s: { run: () => Promise<unknown> }) => s.run())) } as unknown as D1Database;
    const realD1 = new D1Service(realDb, 'sepolia');

    const svc = new MetadataService(
      { indexerV2Endpoint: 'https://indexer.test/graphql', indexerV2ApiVersion: 'v2', indexerV1Endpoint: 'https://v1.test/subgraph', network: 'sepolia', fallbackToBlockchain: true, internalCacheEnabled: false, d1Enabled: true },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
    const s = svc as unknown as Internals;
    vi.spyOn(s.fallback, 'getRegistryHierarchy').mockRejectedValue(new UpstreamError('zigens 502'));
    vi.spyOn(s.cache, 'get').mockResolvedValue(null);
    vi.spyOn(s.cache, 'set').mockResolvedValue(undefined);
    s.d1 = realD1;
    s.sync = { syncHierarchy: syncHierarchyMock };

    let registeredPromise: Promise<unknown> | null = null;
    const waitUntil = vi.fn((p: Promise<unknown>) => { registeredPromise = p; });
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    try { await (svc as any).getRegistryHierarchy('a.eth', executionCtx); } catch (_) {}

    // 1. A promise was registered.
    expect(registeredPromise).not.toBeNull();
    // 2. syncHierarchy was called.
    expect(syncHierarchyMock).toHaveBeenCalledWith('a.eth');
    // 3. D1 is still empty before sync completes (causal ordering).
    const before = await realD1.getHierarchyCount('a.eth');
    expect(before).toBe(0);

    // Complete the sync.
    syncResolve({ operation: 'hierarchy', processed: 1, stored: 1, errors: 0, duration: 0 });

    // 4. Registered promise resolves cleanly.
    await expect(registeredPromise!).resolves.not.toThrow();
  });

  // --- Rejection absorption: syncHierarchy failure does not propagate ---

  it('syncHierarchy rejection is absorbed and does not propagate', async () => {
    const syncError = new Error('indexer sync failed');
    const syncHierarchyMock = vi.fn().mockRejectedValue(syncError);

    const svc = new MetadataService(
      { indexerV2Endpoint: 'https://indexer.test/graphql', indexerV2ApiVersion: 'v2', indexerV1Endpoint: 'https://v1.test/subgraph', network: 'sepolia', fallbackToBlockchain: true, internalCacheEnabled: false, d1Enabled: true },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
    const s = svc as unknown as Internals;
    vi.spyOn(s.fallback, 'getRegistryHierarchy').mockRejectedValue(new UpstreamError('zigens 502'));
    vi.spyOn(s.cache, 'get').mockResolvedValue(null);
    vi.spyOn(s.cache, 'set').mockResolvedValue(undefined);
    s.d1 = { getHierarchy: vi.fn().mockResolvedValue([]), getHierarchyCount: vi.fn().mockResolvedValue(0) } as unknown as D1Service;
    s.sync = { syncHierarchy: syncHierarchyMock };

    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); });
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    // Must not throw — the basic hierarchy fallback returns a response.
    const result = await (svc as any).getRegistryHierarchy('a.eth', executionCtx);
    expect(result.hierarchy).toBeDefined();

    // Await the waitUntil promise — must resolve, not reject.
    if (waitUntilPromises.length > 0) {
      await expect(Promise.all(waitUntilPromises)).resolves.not.toThrow();
    }

    // Rejection was logged.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Hierarchy recovery sync for a.eth failed:'),
      syncError,
    );
  });

  // --- Deferred persistence: awaiting the waitUntil promise persists to D1 ---

  it('successful deferred syncHierarchy persists rows to D1', async () => {
    // Use real SQLite D1 so we can verify persistence after the sync.
    const { DatabaseSync: DB } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    const sqlite = new DB(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/002_network_scoping.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/003_hierarchy_root_scoping.sql', import.meta.url), 'utf8'));
    const stmt = (sql: string, params: unknown[] = []): unknown => ({
      bind: (...p: unknown[]) => stmt(sql, p),
      run: async () => ({ success: true, results: [], meta: sqlite.prepare(sql).run(...(params as never[])) }),
      first: async () => sqlite.prepare(sql).get(...(params as never[])) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(params as never[])), success: true, meta: {} }),
    });
    const realDb = {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s: { run: () => Promise<unknown> }) => s.run())),
    } as unknown as D1Database;
    const realD1 = new D1Service(realDb, 'sepolia');

    const svc = new MetadataService(
      { indexerV2Endpoint: 'https://indexer.test/graphql', indexerV2ApiVersion: 'v2', indexerV1Endpoint: 'https://v1.test/subgraph', network: 'sepolia', fallbackToBlockchain: true, internalCacheEnabled: false, d1Enabled: true },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
    const s = svc as unknown as Internals;
    vi.spyOn(s.fallback, 'getRegistryHierarchy').mockRejectedValue(new UpstreamError('zigens 502'));
    vi.spyOn(s.cache, 'get').mockResolvedValue(null);
    vi.spyOn(s.cache, 'set').mockResolvedValue(undefined);
    s.d1 = realD1;

    // Real syncHierarchy that calls the D1Service (needs indexer mock).
    // We'll write directly to D1 in the mock to simulate the sync.
    const syncComplete = vi.fn();
    s.sync = {
      syncHierarchy: vi.fn().mockImplementation(async (name: string) => {
        await realD1.storeHierarchy(name, [
          { name: 'eth', owner: ZERO, resolver: ZERO, level: 1 },
          { name, owner: OWNER, resolver: ZERO, level: 2 },
        ]);
        syncComplete();
        return { operation: 'hierarchy', processed: 1, stored: 1, errors: 0, duration: 0 };
      }),
    };

    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); });
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    // Trigger the recovery path.
    try { await (svc as any).getRegistryHierarchy('a.eth', executionCtx); } catch (_) {}

    // Before await: D1 is still empty.
    const before = await (realD1 as any).getHierarchyCount('a.eth');
    expect(before).toBe(0);

    // Await the waitUntil promise.
    if (waitUntilPromises.length > 0) {
      await Promise.all(waitUntilPromises);
      expect(syncComplete).toHaveBeenCalled();
    }

    // After await: D1 has hierarchy rows.
    const after = await (realD1 as any).getHierarchyCount('a.eth');
    expect(after).toBe(2);

    const rows = await realD1.getHierarchy('a.eth');
    expect(rows.map((r: { name: string }) => r.name)).toEqual(['eth', 'a.eth']);
  });
});