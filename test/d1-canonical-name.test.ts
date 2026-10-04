import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { D1Service } from '../src/services/d1';
import { MetadataService } from '../src/services/metadata';
import { UpstreamError } from '../src/services/errors';
import { namehash } from '../src/utils/ens';

// D1 is the last-resort tier and is keyed by name. Rows are written lowercase
// (indexer records) or canonicalized (webhook), but reads used to bind the RAW
// request name, so a mixed-case URL like `Fox.eth` never hit its own `fox.eth`
// row and the last resort silently never fired. Every name-keyed read AND write
// must canonicalize at the storage boundary so both sides agree.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

function makeDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          first: async () => null,
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
      },
    }),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
  return { db, calls };
}

describe('D1Service canonicalizes names on reads', () => {
  it('getDomain binds the canonical name', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').getDomain('Fox.ETH');
    expect(calls[0].args).toEqual(['mainnet', 'fox.eth']);
  });

  it('getMigrationStatus reads by the canonical namehash (the row key)', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'sepolia').getMigrationStatus('Fox.ETH');
    expect(calls[0].sql).toContain('id = ?2');
    expect(calls[0].args).toEqual(['sepolia', namehash('fox.eth')]);
  });

  it('getHierarchy keys the root by the canonical namehash', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').getHierarchy('Sub.Fox.ETH');
    expect(calls[0].args).toEqual(['mainnet', namehash('sub.fox.eth')]);
  });

  it('getDomains canonicalizes every name in the IN list', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').getDomains(['Fox.ETH', 'BAR.eth', 'baz.eth']);
    expect(calls[0].args).toEqual(['mainnet', 'fox.eth', 'bar.eth', 'baz.eth']);
  });
});

describe('D1Service canonicalizes names on writes', () => {
  it('storeDomain stores the canonical name, id and label', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').storeDomain({ name: 'Fox.ETH', ownerId: OWNER } as any, 'ensnode');
    const [network, id, name, labelName] = calls[0].args;
    expect(network).toBe('mainnet');
    expect(id).toBe(namehash('fox.eth'));
    expect(name).toBe('fox.eth');
    expect(labelName).toBe('fox');
  });

  it('storeMigrationStatus stores the canonical name and id', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'sepolia').storeMigrationStatus('Fox.ETH', 'migrated', { owner: OWNER });
    const [network, id, name, status] = calls[0].args;
    expect(network).toBe('sepolia');
    expect(id).toBe(namehash('fox.eth'));
    expect(name).toBe('fox.eth');
    expect(status).toBe('migrated');
  });

  it('storeHierarchy keys the root and every level by canonical names', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').storeHierarchy('Fox.ETH', [
      { name: 'ETH', owner: ZERO, resolver: ZERO, level: 1 },
      { name: 'Fox.ETH', owner: OWNER, resolver: ZERO, level: 2 },
    ]);
    // Batch order: INSERT eth, INSERT Fox.eth (no DELETE — no pre-existing rows).
    expect(calls[0].sql).toContain('SELECT');
    expect(calls[1].sql).toContain('INSERT');
    expect(calls[1].args.slice(0, 3)).toEqual(['mainnet', namehash('eth'), 'eth']);
    expect(calls[2].sql).toContain('INSERT');
    expect(calls[2].args.slice(0, 3)).toEqual(['mainnet', namehash('fox.eth'), 'fox.eth']);
    expect(calls[2].args[6]).toBe(namehash('eth')); // parent_id resolved from the canonical level-1 name
  });

  it('a read after a write with different casing hits the same key', async () => {
    const { db, calls } = makeDb();
    const svc = new D1Service(db, 'mainnet');
    await svc.storeMigrationStatus('fox.eth', 'native', {});
    await svc.getMigrationStatus('FOX.eth');
    expect(calls[1].args[1]).toBe(calls[0].args[1]); // the id the write keyed the row by
  });
});

// Rows written before names were canonicalized here keep the request's spelling
// in `name` (sync stored `Fox.eth` as given). Their `id` was always the
// namehash, which normalizes case, so a read by id still finds them. Real SQLite
// with the schema from the migrations; node:sqlite is feature-detected as in
// webhook-warming.test.ts.
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | null = null;
try {
  ({ DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite'));
} catch {
  console.warn('[d1-canonical-name.test] node:sqlite unavailable on this Node — skipping real-SQL D1 suites');
}

describe.skipIf(!DatabaseSync)('D1 migration_status rows written before canonicalization', () => {
  // The same subset of D1 the service uses, over real SQLite.
  function sqliteD1() {
    const sqlite = new DatabaseSync!(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/002_network_scoping.sql', import.meta.url), 'utf8'));
    const stmt = (sql: string, params: unknown[] = []): unknown => ({
      bind: (...p: unknown[]) => stmt(sql, p),
      run: async () => ({ success: true, results: [], meta: sqlite.prepare(sql).run(...(params as never[])) }),
      first: async () => sqlite.prepare(sql).get(...(params as never[])) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(params as never[])), success: true, meta: {} }),
    });
    return { sqlite, db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database };
  }

  // A row exactly as the old storeMigrationStatus('Fox.eth', …) wrote it.
  function withOldRow() {
    const { sqlite, db } = sqliteD1();
    sqlite.prepare(`INSERT INTO migration_status (network, id, name, status, owner, expiration_date, migration_date, last_updated, sync_version)
      VALUES ('sepolia', ?, 'Fox.eth', 'migrated', ?, NULL, NULL, ?, 1)`).run(namehash('Fox.eth'), OWNER, Date.now());
    return { sqlite, d1: new D1Service(db, 'sepolia') };
  }

  it.each(['fox.eth', 'Fox.eth', 'FOX.ETH'])('is found for %s', async (name) => {
    const { d1 } = withOldRow();
    expect(await d1.getMigrationStatus(name)).toMatchObject({ name: 'Fox.eth', status: 'migrated', owner: OWNER });
  });

  it('is replaced, not duplicated, by the next write, which stores the canonical name', async () => {
    const { sqlite, d1 } = withOldRow();
    await d1.storeMigrationStatus('FOX.eth', 'native', {});
    expect(sqlite.prepare('SELECT name, status FROM migration_status').all()).toEqual([{ name: 'fox.eth', status: 'native' }]);
  });

  it('serves MetadataService.getMigrationStatus when every live source fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d1 } = withOldRow();
    const svc = new MetadataService(
      { indexerV2Endpoint: 'https://zigens.test/graphql', network: 'sepolia', fallbackToBlockchain: true, internalCacheEnabled: false, d1Enabled: false },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
    const s = svc as unknown as { d1: D1Service; fallback: { getMigrationStatus: unknown } };
    s.d1 = d1;
    s.fallback.getMigrationStatus = vi.fn().mockRejectedValue(new UpstreamError('indexer and RPC down'));

    const res = await svc.getMigrationStatus('FOX.eth');
    expect(res).toMatchObject({ name: 'FOX.eth', status: 'migrated', owner: OWNER });
    vi.restoreAllMocks();
  });

  it('a name the namehash cannot hash is no row, not an error (the writer could never store one)', async () => {
    const { d1 } = withOldRow();
    await expect(d1.getMigrationStatus('bad:.eth')).resolves.toBeNull();
  });
});
