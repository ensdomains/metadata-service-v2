import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { namehash, labelhash } from '../../src/utils/ens';
import { D1_RETENTION_MS } from '../../src/services/d1';

// Blind acceptance test for W8-CONFIG-002. Drives the Worker's scheduled
// handler, not a private helper: a digit string that parses as Infinity is
// invalid, so cleanup must use the documented 30-day cutoff.

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | null = null;
try {
  ({ DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite'));
} catch {
  console.warn('[w8-config-002-d1-retention-infinity.test] node:sqlite unavailable on this Node — skipping real-SQL D1 suite');
}

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../../migrations/002_network_scoping.sql', import.meta.url)),
  'utf8',
);
const DAY = 24 * 60 * 60 * 1000;
const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
// Decimal spelling of 10^309: one, then 309 zeroes. Number(this) is Infinity.
const INFINITE_RETENTION_SECS = `1${'0'.repeat(309)}`;

vi.mock('../../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

function seedDomain(db: import('node:sqlite').DatabaseSync, network: string, name: string, lastUpdated: number) {
  const label = name.split('.')[0];
  db.prepare(
    `INSERT INTO domains (network, id, name, label_name, labelhash, owner_id, last_updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(network, namehash(name), name, label, labelhash(label), OWNER, lastUpdated);
}

function names(db: import('node:sqlite').DatabaseSync) {
  return (db.prepare(`SELECT network || ':' || name AS k FROM domains ORDER BY k`).all() as Array<{ k: string }>)
    .map((row) => row.k);
}

function makeD1(db: import('node:sqlite').DatabaseSync) {
  const exec = (sql: string, params: unknown[]) => {
    const result = db.prepare(sql).run(...(params as never[]));
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  };
  const all = (sql: string, params: unknown[]) => {
    const results = db.prepare(sql).all(...(params as never[]));
    return { success: true, results, meta: {} };
  };
  const stmt = (sql: string, params: unknown[] = []): unknown => ({
    bind: (...bound: unknown[]) => stmt(sql, bound),
    run: async () => exec(sql, params),
    all: async () => all(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])),
  });
  return {
    prepare: (sql: string) => stmt(sql),
  };
}

describe.skipIf(!DatabaseSync)('W8-CONFIG-002 scheduled retention', () => {
  it('treats a non-finite D1_RETENTION_SECS as invalid and uses the 30-day default cutoff', async () => {
    expect(INFINITE_RETENTION_SECS).toMatch(/^1(?:0){309}$/);
    expect(Number(INFINITE_RETENTION_SECS)).toBe(Number.POSITIVE_INFINITY);

    const db = new DatabaseSync!(':memory:');
    db.exec(SCHEMA);
    const oldAt = Date.now() - D1_RETENTION_MS - DAY;
    const freshAt = Date.now() - DAY;
    for (const network of ['mainnet', 'sepolia']) {
      seedDomain(db, network, 'old.eth', oldAt);
      seedDomain(db, network, 'fresh.eth', freshAt);
    }

    vi.resetModules();
    const app = (await import('../../src/index')).default;
    await app.scheduled(
      { cron: '17 4 * * *', scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      {
        DB: makeD1(db),
        D1_RETENTION_SECS: INFINITE_RETENTION_SECS,
      } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );

    // 30-day default: the older row is past the cutoff; the one-day-old row is not.
    expect(names(db)).toEqual(['mainnet:fresh.eth', 'sepolia:fresh.eth']);
  });
});
