import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { D1Service } from '../src/services/d1';
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
});