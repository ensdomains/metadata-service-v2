import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { D1Service, D1_READ_MAX_AGE_MS } from '../src/services/d1';
import { namehash, canonicalizeName } from '../src/utils/ens';

// W8-D1-001: storeHierarchy's explicit per-domain replacement promise — storing
// one root must not corrupt a sibling root that shares an ancestor.
//
// The registry_hierarchy PRIMARY KEY (network, id) makes the second
// INSERT OR REPLACE move a shared ancestor row (e.g., eth) from the first
// root_domain_id to the second, so getHierarchy("a.eth") returns only [a.eth]
// instead of the intact root-first [eth, a.eth] after b.eth is stored.
//
// The fix (migration 003) changes the PK to (network, id, root_domain_id) so
// each domain owns its ancestor rows independently.
//
// External closure also found:
//  - P2 (bug/performance): getHierarchy needs composite index
//    (network, root_domain_id, level) so the planner does a seek not a
//    network-wide level scan.
//  - P2 (security/availability): migration 003 drops hierarchy rows; fresh
//    domain sync returns early, leaving hierarchy empty indefinitely.
//    Backfill fires when hierarchy is missing for a fresh domain.

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

describe.skipIf(!DatabaseSync)('D1 hierarchy isolation (W8-D1-001)', () => {
  // The same subset of D1 the service uses, over real SQLite.
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

  it('getHierarchy("a.eth") returns the intact root-first [eth, a.eth] hierarchy after b.eth is stored', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');

    // Store a.eth with its hierarchy.
    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);

    // Store b.eth — shares eth as ancestor.
    await d1.storeHierarchy('b.eth', [ethAncestor(), bEthDomain()]);

    // Read a.eth back. On the baseline schema (PK (network, id) only),
    // the second storeHierarchy moves the shared eth row to b.eth's
    // root_domain_id, so only [a.eth] is returned. The fix makes the PK
    // (network, id, root_domain_id) so each domain owns its eth row.
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
    // Update a.eth's hierarchy with a different resolver for eth.
    await d1.storeHierarchy('a.eth', [
      { name: 'eth', owner: ZERO, resolver: '0x1111111111111111111111111111111111111111', level: 1 },
      aEthDomain(),
    ]);

    const results = await d1.getHierarchy('a.eth');
    expect(results).toHaveLength(2);

    const ethRow = results.find((r) => r.name === 'eth');
    expect(ethRow!.resolver).toBe('0x1111111111111111111111111111111111111111');
  });

  // P2 (performance): EXPLAIN QUERY PLAN must use the composite index
  // idx_hierarchy_root_level for getHierarchy's WHERE + ORDER BY. Without
  // it the planner chooses from separate indexes and may scan by level
  // across the whole network before filtering by root_domain_id.
  it('EXPLAIN QUERY PLAN uses composite index idx_hierarchy_root_level for getHierarchy', () => {
    const { sqlite } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');

    // Insert rows across multiple root domains so the planner has a
    // meaningful choice. 20 domains, 3 levels each.
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

    // The composite index idx_hierarchy_root_level must appear in the plan.
    // On HEAD without it, the planner uses separate indexes and the
    // composite index name is absent.
    const planText = JSON.stringify(plan);
    expect(planText).toContain('idx_hierarchy_root_level');

    // Regression: 3 levels filtered correctly for d5.eth.
    const results = sqlite.prepare(
      'SELECT COUNT(*) as cnt FROM registry_hierarchy WHERE network = ? AND root_domain_id = ?'
    ).get('mainnet', rootDomainId) as { cnt: number };
    expect(results.cnt).toBe(3);
  });

  // P2 (availability): after migration 003 drops hierarchy, getHierarchyCount
  // returns 0 even when the domain row exists. syncDomain must check this and
  // fire a backfill. This test proves the count method exists and is correct.
  it('getHierarchyCount returns 0 after migration when hierarchy is empty', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');

    const count = await d1.getHierarchyCount('a.eth');
    expect(count).toBe(0);
  });

  it('getHierarchyCount returns the correct level count after storeHierarchy', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1 = new D1Service(db, 'mainnet');

    await d1.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);
    const count = await d1.getHierarchyCount('a.eth');
    expect(count).toBe(2);
  });

  // Cross-network isolation: same id/root on mainnet and sepolia must not
  // interfere. The PK (network, id, root_domain_id) includes network.
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

  // Verify the PK cannot silently lose the network column — a write on one
  // network must never affect the other.
  it('storeHierarchy on mainnet does not touch sepolia rows', async () => {
    const { db } = sqliteD1('../migrations/003_hierarchy_root_scoping.sql');
    const d1Mainnet = new D1Service(db, 'mainnet');
    const d1Sepolia = new D1Service(db, 'sepolia');

    await d1Sepolia.storeHierarchy('a.eth', [
      { name: 'eth', owner: '0xSEP', resolver: ZERO, level: 1 },
      aEthDomain(),
    ]);

    // Now store on mainnet — must not affect sepolia rows.
    await d1Mainnet.storeHierarchy('a.eth', [ethAncestor(), aEthDomain()]);

    const sepoliaResults = await d1Sepolia.getHierarchy('a.eth');
    const sepoliaEthRow = sepoliaResults.find((r) => r.name === 'eth');
    expect(sepoliaEthRow!.owner).toBe('0xSEP');
  });
});