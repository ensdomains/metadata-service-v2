import { describe, expect, it, vi } from 'vitest';
import { D1_RETENTION_MS } from '../src/services/d1';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

type Row = {
  table: 'domains' | 'migration_status' | 'registry_hierarchy';
  network: string;
  name: string;
  lastUpdated: number;
};

function makeD1(rows: Row[]) {
  const prepare = (sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: async () => {
        const table = /DELETE FROM (domains|migration_status|registry_hierarchy)/.exec(sql)?.[1];
        if (!table) throw new Error(`Unexpected run query: ${sql}`);
        const [network, cutoff, limit] = params as [string, number, number];
        const doomed = rows
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row.table === table && row.network === network && row.lastUpdated < cutoff)
          .slice(0, limit)
          .map(({ index }) => index);
        for (const index of doomed.reverse()) rows.splice(index, 1);
        return { success: true, results: [], meta: { changes: doomed.length } };
      },
      all: async () => {
        const [network] = params as [string];
        const count = (table: Row['table']) => rows.filter((row) => row.table === table && row.network === network).length;
        return {
          success: true,
          results: [{
            domains: count('domains'),
            migration_status: count('migration_status'),
            registry_hierarchy: count('registry_hierarchy'),
          }],
          meta: {},
        };
      },
    }),
  });
  return { prepare };
}

// Exact operational boundary in seconds.
const MAX_ENV_SECS = 10 * 365 * 24 * 60 * 60; // 315,360,000
const MAX_PLUS_ONE  = MAX_ENV_SECS + 1;        // 315,360,001
// MAX_SAFE_INTEGER / 1000 ≈ 9,007,199,254.741; floor is 9,007,199,254,741.
const SAFE_SECS_UNSAFE_MS = 9_007_199_254_741;

describe('scheduled D1 retention — envSecsToMs guard gaps', () => {
  const now = Date.now();

  it('rejects an unsafe-integer digit string and uses the 30-day default', async () => {
    const rows: Row[] = [
      { table: 'domains', network: 'mainnet', name: 'old.eth', lastUpdated: now - D1_RETENTION_MS - 24 * 60 * 60 * 1000 },
      { table: 'domains', network: 'mainnet', name: 'fresh.eth', lastUpdated: now - D1_RETENTION_MS + 24 * 60 * 60 * 1000 },
    ];
    const app = (await import('../src/index')).default;
    await app.scheduled(
      { cron: '17 4 * * *', scheduledTime: now, noRetry: () => {} } as ScheduledController,
      { DB: makeD1(rows), D1_RETENTION_SECS: '9'.repeat(16) } as never,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    expect(rows.filter((r) => r.table === 'domains').map((r) => r.name)).toEqual(['fresh.eth']);
  });

  it('rejects safe seconds whose millisecond product is unsafe and uses the 30-day default', async () => {
    const rows: Row[] = [
      { table: 'domains', network: 'mainnet', name: 'old.eth', lastUpdated: now - D1_RETENTION_MS - 24 * 60 * 60 * 1000 },
      { table: 'domains', network: 'mainnet', name: 'fresh.eth', lastUpdated: now - D1_RETENTION_MS + 24 * 60 * 60 * 1000 },
    ];
    const app = (await import('../src/index')).default;
    await app.scheduled(
      { cron: '17 4 * * *', scheduledTime: now, noRetry: () => {} } as ScheduledController,
      { DB: makeD1(rows), D1_RETENTION_SECS: String(SAFE_SECS_UNSAFE_MS) } as never,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    expect(rows.filter((r) => r.table === 'domains').map((r) => r.name)).toEqual(['fresh.eth']);
  });

  it('rejects max+1 and falls back to the 30-day default (31-day-old row deleted)', async () => {
    const rows: Row[] = [
      { table: 'domains', network: 'mainnet', name: 'old.eth', lastUpdated: now - D1_RETENTION_MS - 24 * 60 * 60 * 1000 },
      { table: 'domains', network: 'mainnet', name: 'fresh.eth', lastUpdated: now - D1_RETENTION_MS + 24 * 60 * 60 * 1000 },
    ];
    const app = (await import('../src/index')).default;
    await app.scheduled(
      { cron: '17 4 * * *', scheduledTime: now, noRetry: () => {} } as ScheduledController,
      { DB: makeD1(rows), D1_RETENTION_SECS: String(MAX_PLUS_ONE) } as never,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    expect(rows.filter((r) => r.table === 'domains').map((r) => r.name)).toEqual(['fresh.eth']);
  });

  it('honors the exact operational maximum (10 years) — kills >= mutant via 9-year row', async () => {
    // 11-year row: older than the 10-year max → deleted.
    // 9-year row: younger than the 10-year max → KEPT under >, DELETED under >=.
    // A >= MAX_ENV_SECS mutant rejects 315360000 and falls back to 30 days, which
    // deletes the 9-year row (9y > 30d). The > guard keeps it. This kills the mutant.
    const row11y = now - (11 * 365 * 24 * 60 * 60 * 1000);
    const row9y  = now - (9  * 365 * 24 * 60 * 60 * 1000);
    const rows: Row[] = [
      { table: 'domains', network: 'mainnet', name: 'old11y.eth', lastUpdated: row11y },
      { table: 'domains', network: 'mainnet', name: 'keep9y.eth', lastUpdated: row9y },
    ];
    const app = (await import('../src/index')).default;
    await app.scheduled(
      { cron: '17 4 * * *', scheduledTime: now, noRetry: () => {} } as ScheduledController,
      { DB: makeD1(rows), D1_RETENTION_SECS: String(MAX_ENV_SECS) } as never,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
    );
    // 10-year cutoff: 11y deleted, 9y kept.
    expect(rows.filter((r) => r.table === 'domains').map((r) => r.name)).toEqual(['keep9y.eth']);
  });
});