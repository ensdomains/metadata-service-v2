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
});

// === Route-level recovery test (mock-based) =================================
//
// After migration 003 drops registry_hierarchy, getRegistryHierarchy's D1
// fallback returns empty. The route must trigger syncHierarchy via waitUntil
// so the Worker runtime keeps the isolate alive until the sync completes.
// This covers both direct /registry-hierarchy traffic and fresh-domain traffic
// that hits the hierarchy route without going through syncDomain.

describe('getRegistryHierarchy D1 fallback triggers syncHierarchy via waitUntil', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function makeService() {
    const svc = new MetadataService(
      {
        indexerV2Endpoint: 'https://indexer.test/graphql',
        indexerV2ApiVersion: 'v2',
        indexerV1Endpoint: 'https://v1.test/subgraph',
        network: 'sepolia',
        fallbackToBlockchain: true,
        internalCacheEnabled: false,
        d1Enabled: false,
      },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );

    type Internals = {
      indexerV2: { getHierarchy: (name: string) => Promise<unknown> };
      indexerV1: { getHierarchy: (name: string) => Promise<unknown> } | null;
      blockchain: { executeWithFallback: (...args: unknown[]) => Promise<unknown> };
      d1: D1Service | null;
      sync: { syncHierarchy: (name: string, force?: boolean) => Promise<unknown> } | null;
    };

    const s = svc as unknown as Internals;

    // All upstream sources fail.
    vi.spyOn(s.indexerV2, 'getHierarchy').mockRejectedValue(new UpstreamError('zigens 502'));
    if (s.indexerV1) {
      vi.spyOn(s.indexerV1, 'getHierarchy').mockRejectedValue(new UpstreamError('v1 down'));
    }
    vi.spyOn(s.blockchain, 'executeWithFallback').mockRejectedValue(new UpstreamError('all RPCs failed'));

    // D1 hierarchy is empty (post-migration state).
    s.d1 = {
      getHierarchy: vi.fn().mockResolvedValue([]),
    } as unknown as D1Service;

    // syncHierarchy mock — will be awaited through waitUntil.
    const syncHierarchyMock = vi.fn().mockResolvedValue({
      operation: 'hierarchy',
      processed: 1,
      stored: 1,
      errors: 0,
      duration: 0,
    });
    s.sync = { syncHierarchy: syncHierarchyMock };

    return { svc, syncHierarchyMock };
  }

  it('triggers syncHierarchy via waitUntil when D1 hierarchy is empty and all upstreams fail', async () => {
    const { svc, syncHierarchyMock } = makeService();
    const waitUntil = vi.fn((p: Promise<unknown>) => p);
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    // getRegistryHierarchy currently does not accept executionCtx on HEAD.
    // Cast through any so the test compiles before the parameter is added;
    // it will throw UpstreamError on HEAD because no recovery exists.
    try {
      await (svc as any).getRegistryHierarchy('a.eth', executionCtx);
    } catch (e) {
      // UpstreamError is expected on HEAD — every tier failed and no
      // recovery path exists yet. The fix adds recovery via waitUntil
      // so this error becomes a fallback D1 response instead.
      expect(e).toBeInstanceOf(UpstreamError);
    }

    // On HEAD: waitUntil is never called (no recovery). After the fix:
    // waitUntil must be called with a promise that completes syncHierarchy.
    expect(waitUntil).toHaveBeenCalled();
  });

  it('the waitUntil promise completes syncHierarchy and resolves without unhandled rejection', async () => {
    const { svc, syncHierarchyMock } = makeService();
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    });
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    try {
      await (svc as any).getRegistryHierarchy('a.eth', executionCtx);
    } catch (_) {
      // swallowed on HEAD — every tier fails and no recovery
    }

    // On HEAD: waitUntil never called. After the fix: the promise is
    // registered, and awaiting it completes the sync.
    if (waitUntilPromises.length > 0) {
      await Promise.all(waitUntilPromises);
      expect(syncHierarchyMock).toHaveBeenCalledWith('a.eth');
      // No unhandled rejection — the promise resolves cleanly.
    } else {
      // HEAD behaviour: the test records the absence.
      expect(waitUntilPromises.length).toBeGreaterThan(0);
    }
  });

  it('does not trigger syncHierarchy when D1 has existing hierarchy rows', async () => {
    const { svc, syncHierarchyMock } = makeService();

    // Override D1 to return existing hierarchy.
    const s = svc as unknown as {
      d1: { getHierarchy: (name: string) => Promise<unknown> };
    };
    s.d1.getHierarchy = vi.fn().mockResolvedValue([
      { name: 'eth', owner: ZERO, resolver: ZERO, level: 1 },
      { name: 'a.eth', owner: OWNER, resolver: ZERO, level: 2 },
    ]);

    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() };

    await (svc as any).getRegistryHierarchy('a.eth', executionCtx);

    // D1 had data — no recovery needed, no sync triggered.
    expect(syncHierarchyMock).not.toHaveBeenCalled();
  });
});