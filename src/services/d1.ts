// D1 service for local ensnode data storage and fast queries.
//
// Every instance is scoped to a single network (passed to the constructor): one
// worker serves both mainnet and sepolia and namehash collides across networks,
// so all reads/writes filter by `network` to keep the two from overwriting each
// other. See migrations/001_initial_schema.sql.
//
// Every name-keyed read and write canonicalizes the name (NFC + lowercase) at
// this boundary. Rows arrive lowercase from the indexer and canonicalized from
// the webhook, while request names may be mixed-case — without this a `Fox.eth`
// request never found its own `fox.eth` row.
import { namehash, labelhash, canonicalizeName } from '../utils/ens';
import type { IndexerDomain } from './indexer';
import type { MigrationStatus } from '../types';
import { SUPPORTED_NETWORKS, type NetworkName } from '../config/networks';

const DAY_MS = 24 * 60 * 60 * 1000;

// D1 is the last-resort tier, so a row read back from it is served as current.
// Rows whose last_updated is older than this are treated as a miss on read.
// Override with the D1_READ_MAX_AGE_SECS env var.
export const D1_READ_MAX_AGE_MS = 7 * DAY_MS;

// Rows whose last_updated is older than this are deleted by the daily retention
// job (the `scheduled` handler in src/index.ts). Override with D1_RETENTION_SECS.
export const D1_RETENTION_MS = 30 * DAY_MS;

// The retention job deletes in chunks of this many rows per statement, and at
// most this many chunks per table per network per run: no single DELETE holds
// D1's one writer for long, and a run stays well inside the per-invocation
// query limit. Rows a capped run leaves behind go on the next run.
export const D1_CLEANUP_CHUNK_ROWS = 5000;
export const D1_CLEANUP_MAX_CHUNKS = 40;

// updateSyncStatus writes a (network, operation) row at most once per this
// interval per isolate, or at once when the outcome flips (see there).
export const SYNC_STATUS_WRITE_INTERVAL_MS = 5 * 60 * 1000;

// Tables the retention job prunes (sync_status holds one row per operation).
const RETAINED_TABLES = ['domains', 'migration_status', 'registry_hierarchy'] as const;
type RetainedTable = typeof RETAINED_TABLES[number];
export type D1TableCounts = Record<RetainedTable, number>;

export interface D1DomainRecord {
  network: NetworkName;
  id: string; // namehash
  name: string;
  label_name: string;
  labelhash: string;
  parent_id: string | null;
  owner_id: string | null;
  resolver_id: string | null;
  registrant_id: string | null;
  expiry_date: string | null;
  created_at: string | null;
  ttl: number | null;
  is_migrated: boolean;
  data_source: 'ensnode' | 'blockchain';
  last_updated: number;
  sync_version: number;
}

export interface D1MigrationRecord {
  network: NetworkName;
  id: string; // namehash
  name: string;
  status: MigrationStatus;
  owner: string | null;
  expiration_date: string | null;
  migration_date: string | null;
  last_updated: number;
  sync_version: number;
}

export interface D1HierarchyRecord {
  network: NetworkName;
  id: string; // namehash
  name: string;
  owner: string;
  resolver: string;
  level: number;
  parent_id: string | null;
  root_domain_id: string;
  last_updated: number;
  sync_version: number;
}

export interface D1SyncStatus {
  network: NetworkName;
  operation: 'domains' | 'migration' | 'hierarchy';
  last_sync: number;
  last_successful_sync: number;
  sync_count: number;
  error_count: number;
  last_error: string | null;
}

export interface D1ServiceOptions {
  /** Rows older than this are a miss on read (default D1_READ_MAX_AGE_MS). */
  readMaxAgeMs?: number;
}

export interface D1CleanupResult {
  deleted: D1TableCounts;
  /** False when the chunk cap stopped the run with expired rows possibly left. */
  complete: boolean;
}

// updateSyncStatus calls not yet written to the sync_status row.
interface PendingSyncStatus {
  lastWrite: number;
  lastSuccess: boolean;
  syncs: number;
  errors: number;
  lastSuccessfulSync: number | null;
}

export class D1Service {
  private readMaxAgeMs: number;
  private pendingSyncStatus = new Map<D1SyncStatus['operation'], PendingSyncStatus>();

  constructor(private db: D1Database, private network: NetworkName, options: D1ServiceOptions = {}) {
    this.readMaxAgeMs = options.readMaxAgeMs ?? D1_READ_MAX_AGE_MS;
  }

  // A row older than the read max age is a miss (see D1_READ_MAX_AGE_MS).
  private isFresh(row: { last_updated: number }): boolean {
    return Date.now() - Number(row.last_updated) <= this.readMaxAgeMs;
  }

  // Domain operations
  async storeDomain(domain: IndexerDomain, dataSource: 'ensnode' | 'blockchain' = 'ensnode'): Promise<void> {
    await this.domainStatement(domain, dataSource).run();
  }

  private domainStatement(domain: IndexerDomain, dataSource: 'ensnode' | 'blockchain'): D1PreparedStatement {
    const canonicalName = canonicalizeName(domain.name);
    const record: Omit<D1DomainRecord, 'sync_version'> = {
      network: this.network,
      id: namehash(canonicalName),
      name: canonicalName,
      label_name: domain.labelName || canonicalName.split('.')[0],
      labelhash: domain.labelhash || labelhash(canonicalName.split('.')[0]),
      parent_id: domain.parentId || null,
      owner_id: domain.ownerId || null,
      resolver_id: domain.resolverId || null,
      registrant_id: domain.registrantId || null,
      expiry_date: domain.expiryDate || null,
      created_at: domain.createdAt || null,
      ttl: domain.ttl || null,
      is_migrated: domain.isMigrated || false,
      data_source: dataSource,
      last_updated: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO domains (
        network, id, name, label_name, labelhash, parent_id, owner_id, resolver_id,
        registrant_id, expiry_date, created_at, ttl, is_migrated,
        data_source, last_updated, sync_version
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        COALESCE((SELECT sync_version FROM domains WHERE network = ?1 AND id = ?2), 0) + 1
      )
    `);

    return stmt.bind(
      record.network, record.id, record.name, record.label_name, record.labelhash,
      record.parent_id, record.owner_id, record.resolver_id, record.registrant_id,
      record.expiry_date, record.created_at, record.ttl, record.is_migrated ? 1 : 0,
      record.data_source, record.last_updated
    );
  }

  async getDomain(name: string): Promise<D1DomainRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE network = ?1 AND name = ?2');
    const result = await stmt.bind(this.network, canonicalizeName(name)).first<D1DomainRecord>();
    if (!result || !this.isFresh(result)) return null;

    result.is_migrated = Boolean(result.is_migrated);
    return result;
  }

  async getDomainById(id: string): Promise<D1DomainRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE network = ?1 AND id = ?2');
    const result = await stmt.bind(this.network, id).first<D1DomainRecord>();
    if (!result || !this.isFresh(result)) return null;

    result.is_migrated = Boolean(result.is_migrated);
    return result;
  }

  // Migration status operations
  async storeMigrationStatus(name: string, status: MigrationStatus, data: {
    owner?: string;
    expirationDate?: string;
    migrationDate?: string;
  }): Promise<void> {
    const canonical = canonicalizeName(name);
    const record: Omit<D1MigrationRecord, 'sync_version'> = {
      network: this.network,
      id: namehash(canonical),
      name: canonical,
      status,
      owner: data.owner || null,
      expiration_date: data.expirationDate || null,
      migration_date: data.migrationDate || null,
      last_updated: Date.now(),
    };

    // Partial updates (e.g. the webhook passes only the status) must not wipe
    // fields a fuller sync already stored: REPLACE rewrites the whole row, so
    // absent inputs fall back to the existing row's values via COALESCE.
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO migration_status (
        network, id, name, status, owner, expiration_date, migration_date,
        last_updated, sync_version
      ) VALUES (
        ?1, ?2, ?3, ?4,
        COALESCE(?5, (SELECT owner FROM migration_status WHERE network = ?1 AND id = ?2)),
        COALESCE(?6, (SELECT expiration_date FROM migration_status WHERE network = ?1 AND id = ?2)),
        COALESCE(?7, (SELECT migration_date FROM migration_status WHERE network = ?1 AND id = ?2)),
        ?8,
        COALESCE((SELECT sync_version FROM migration_status WHERE network = ?1 AND id = ?2), 0) + 1
      )
    `);

    await stmt.bind(
      record.network, record.id, record.name, record.status, record.owner,
      record.expiration_date, record.migration_date, record.last_updated
    ).run();
  }

  // By id, the row's key: rows written before names were canonicalized here
  // kept the request's spelling in `name` (`Fox.eth`), but their id was always
  // the namehash, which normalizes case, so it finds them for any spelling.
  async getMigrationStatus(name: string): Promise<D1MigrationRecord | null> {
    let id: string;
    try {
      id = namehash(canonicalizeName(name));
    } catch {
      return null; // the namehash rejects the name, so no row was ever written for it
    }
    const stmt = this.db.prepare('SELECT * FROM migration_status WHERE network = ?1 AND id = ?2');
    const result = await stmt.bind(this.network, id).first<D1MigrationRecord>();
    return result && this.isFresh(result) ? result : null;
  }

  // Registry hierarchy operations
  async storeHierarchy(name: string, hierarchy: Array<{
    name: string;
    owner: string;
    resolver: string;
    level: number;
  }>): Promise<void> {
    const rootDomainId = namehash(canonicalizeName(name));

    // Clear the existing hierarchy for this domain and insert the new records,
    // in one batch (one round trip, one transaction).
    const statements = [
      this.db.prepare('DELETE FROM registry_hierarchy WHERE network = ?1 AND root_domain_id = ?2')
        .bind(this.network, rootDomainId),
    ];

    for (const level of hierarchy) {
      const record: Omit<D1HierarchyRecord, 'sync_version'> = {
        network: this.network,
        id: namehash(canonicalizeName(level.name)),
        name: canonicalizeName(level.name),
        owner: level.owner,
        resolver: level.resolver,
        level: level.level,
        parent_id: level.level > 1 ? namehash(canonicalizeName(hierarchy.find(h => h.level === level.level - 1)?.name || '')) : null,
        root_domain_id: rootDomainId,
        last_updated: Date.now(),
      };

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO registry_hierarchy (
          network, id, name, owner, resolver, level, parent_id, root_domain_id,
          last_updated, sync_version
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
          COALESCE((SELECT sync_version FROM registry_hierarchy WHERE network = ?1 AND id = ?2), 0) + 1
        )
      `);

      statements.push(stmt.bind(
        record.network, record.id, record.name, record.owner, record.resolver, record.level,
        record.parent_id, record.root_domain_id, record.last_updated
      ));
    }

    await this.db.batch(statements);
  }

  async getHierarchy(name: string): Promise<D1HierarchyRecord[]> {
    const rootDomainId = namehash(canonicalizeName(name));
    const stmt = this.db.prepare(`
      SELECT * FROM registry_hierarchy
      WHERE network = ?1 AND root_domain_id = ?2
      ORDER BY level ASC
    `);
    const result = await stmt.bind(this.network, rootDomainId).all<D1HierarchyRecord>();
    return (result.results || []).filter((record) => this.isFresh(record));
  }

  // Batch operations. All rows go in one db.batch() (one round trip and one
  // transaction), not one awaited statement per domain. The batch is atomic:
  // if it fails, none of the rows is stored.
  async storeDomains(domains: IndexerDomain[], dataSource: 'ensnode' | 'blockchain' = 'ensnode'): Promise<number> {
    const statements: D1PreparedStatement[] = [];

    for (const domain of domains) {
      try {
        statements.push(this.domainStatement(domain, dataSource));
      } catch (error) {
        console.error(`Failed to store domain ${domain.name}:`, error);
      }
    }

    if (statements.length === 0) return 0;

    try {
      await this.db.batch(statements);
      return statements.length;
    } catch (error) {
      console.error(`Failed to store ${statements.length} domains:`, error);
      return 0;
    }
  }

  async getDomains(names: string[]): Promise<D1DomainRecord[]> {
    if (names.length === 0) return [];

    const placeholders = names.map((_, i) => `?${i + 2}`).join(', ');
    const stmt = this.db.prepare(`SELECT * FROM domains WHERE network = ?1 AND name IN (${placeholders})`);
    const result = await stmt.bind(this.network, ...names.map(canonicalizeName)).all<D1DomainRecord>();

    return (result.results || []).filter((record) => this.isFresh(record)).map(record => ({
      ...record,
      is_migrated: Boolean(record.is_migrated)
    }));
  }

  // Sync status operations. Every sync used to rewrite its (network, operation)
  // row: one hot row on D1's single writer, rewritten several times per
  // request. Now a call writes only when the outcome flips or the interval has
  // passed since this isolate last wrote the row. The calls in between are
  // counted in memory and added by the next write, so sync_count/error_count
  // only miss the counts an isolate still holds when it is evicted.
  async updateSyncStatus(operation: 'domains' | 'migration' | 'hierarchy', success: boolean, error?: string): Promise<void> {
    const now = Date.now();
    const pending = this.pendingSyncStatus.get(operation);
    const syncs = (pending?.syncs ?? 0) + 1;
    const errors = (pending?.errors ?? 0) + (success ? 0 : 1);
    const lastSuccessfulSync = success ? now : (pending?.lastSuccessfulSync ?? null);

    if (pending && pending.lastSuccess === success && now - pending.lastWrite < SYNC_STATUS_WRITE_INTERVAL_MS) {
      this.pendingSyncStatus.set(operation, { ...pending, syncs, errors, lastSuccessfulSync });
      return;
    }

    // Recorded before the write, so concurrent calls don't all write.
    this.pendingSyncStatus.set(operation, {
      lastWrite: now, lastSuccess: success, syncs: 0, errors: 0, lastSuccessfulSync: null,
    });

    // Upsert: the (network, operation) row is created on first sync, so there's
    // no need to seed per-network rows in the schema.
    const stmt = this.db.prepare(`
      INSERT INTO sync_status (
        network, operation, last_sync, last_successful_sync,
        sync_count, error_count, last_error
      ) VALUES (
        ?1, ?2, ?3, COALESCE(?6, 0), ?4, ?5, ?7
      )
      ON CONFLICT(network, operation) DO UPDATE SET
        last_sync = ?3,
        last_successful_sync = COALESCE(?6, sync_status.last_successful_sync),
        sync_count = sync_status.sync_count + ?4,
        error_count = sync_status.error_count + ?5,
        last_error = ?7
    `);

    try {
      await stmt.bind(this.network, operation, now, syncs, errors, lastSuccessfulSync, error || null).run();
    } catch (writeError) {
      // Let the next call write instead of waiting out the interval.
      this.pendingSyncStatus.delete(operation);
      throw writeError;
    }
  }

  async getSyncStatus(operation?: 'domains' | 'migration' | 'hierarchy'): Promise<D1SyncStatus[]> {
    let stmt;
    if (operation) {
      stmt = this.db.prepare('SELECT * FROM sync_status WHERE network = ?1 AND operation = ?2');
      const result = await stmt.bind(this.network, operation).all<D1SyncStatus>();
      return result.results || [];
    } else {
      stmt = this.db.prepare('SELECT * FROM sync_status WHERE network = ?1 ORDER BY operation');
      const result = await stmt.bind(this.network).all<D1SyncStatus>();
      return result.results || [];
    }
  }

  // Cache-like operations for fast lookups
  async findStaleRecords(operation: 'domains' | 'migration' | 'hierarchy', maxAge: number): Promise<string[]> {
    const cutoff = Date.now() - maxAge;

    let stmt;
    switch (operation) {
      case 'domains':
        stmt = this.db.prepare('SELECT name FROM domains WHERE network = ?1 AND last_updated < ?2');
        break;
      case 'migration':
        stmt = this.db.prepare('SELECT name FROM migration_status WHERE network = ?1 AND last_updated < ?2');
        break;
      case 'hierarchy':
        stmt = this.db.prepare('SELECT DISTINCT name FROM registry_hierarchy WHERE network = ?1 AND last_updated < ?2');
        break;
    }

    const result = await stmt.bind(this.network, cutoff).all<{ name: string }>();
    return (result.results || []).map(r => r.name);
  }

  // Health check
  async healthCheck(): Promise<{ connected: boolean; recordCount: number }> {
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM domains WHERE network = ?1');
      const result = await stmt.bind(this.network).first<{ count: number }>();

      return {
        connected: true,
        recordCount: result?.count || 0,
      };
    } catch (error) {
      return {
        connected: false,
        recordCount: 0,
      };
    }
  }

  // Cleanup old records: delete the rows whose last_updated is older than
  // maxAge, in chunks (see D1_CLEANUP_CHUNK_ROWS).
  async cleanup(maxAge: number = D1_RETENTION_MS): Promise<D1CleanupResult> {
    const cutoff = Date.now() - maxAge;
    const deleted: D1TableCounts = { domains: 0, migration_status: 0, registry_hierarchy: 0 };
    let complete = true;

    for (const table of RETAINED_TABLES) {
      for (let chunk = 0; ; chunk++) {
        if (chunk === D1_CLEANUP_MAX_CHUNKS) {
          complete = false;
          break;
        }
        const { meta } = await this.db.prepare(`
          DELETE FROM ${table} WHERE rowid IN (
            SELECT rowid FROM ${table} WHERE network = ?1 AND last_updated < ?2 LIMIT ?3
          )
        `).bind(this.network, cutoff, D1_CLEANUP_CHUNK_ROWS).run();
        const changes = meta.changes || 0;
        deleted[table] += changes;
        if (changes < D1_CLEANUP_CHUNK_ROWS) break;
      }
    }

    return { deleted, complete };
  }

  // Row counts per table for this network, plus the database size in bytes
  // when D1 reports it (meta.size_after). The retention job logs both.
  async tableCounts(): Promise<{ counts: D1TableCounts; dbSizeBytes: number | null }> {
    const result = await this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM domains WHERE network = ?1) AS domains,
        (SELECT COUNT(*) FROM migration_status WHERE network = ?1) AS migration_status,
        (SELECT COUNT(*) FROM registry_hierarchy WHERE network = ?1) AS registry_hierarchy
    `).bind(this.network).all<D1TableCounts>();
    const row = result.results?.[0];
    return {
      counts: {
        domains: Number(row?.domains ?? 0),
        migration_status: Number(row?.migration_status ?? 0),
        registry_hierarchy: Number(row?.registry_hierarchy ?? 0),
      },
      dbSizeBytes: typeof result.meta?.size_after === 'number' ? result.meta.size_after : null,
    };
  }
}

// Daily retention job (the Worker's `scheduled` handler). For every network it
// deletes the rows not refreshed within the retention period, then logs what
// was removed and what remains. That log line is the size signal: alert on it
// in Workers Observability (dbSizeBytes nearing D1's 10 GB limit, remaining
// counts growing run over run, or complete=false). It is logged as a JSON
// string, which stays parseable when the console is wrapped for secret
// redaction (an object would reach the log as inspected text there). If a network fails, the run
// throws after the other networks have run, so the cron event shows it too.
export async function runD1Retention(db: D1Database, retentionMs: number = D1_RETENTION_MS): Promise<void> {
  const failed: NetworkName[] = [];

  for (const network of SUPPORTED_NETWORKS) {
    try {
      const d1 = new D1Service(db, network);
      const { deleted, complete } = await d1.cleanup(retentionMs);
      const { counts, dbSizeBytes } = await d1.tableCounts();
      const total = deleted.domains + deleted.migration_status + deleted.registry_hierarchy;
      console.log(JSON.stringify({
        message: `[d1-retention] ${network}: deleted ${total} rows past retention`,
        network,
        retentionDays: retentionMs / DAY_MS,
        deleted,
        remaining: counts,
        dbSizeBytes,
        complete,
      }));
    } catch (error) {
      failed.push(network);
      console.error(`[d1-retention] ${network}: retention run failed:`, error);
    }
  }

  if (failed.length > 0) {
    throw new Error(`D1 retention failed for ${failed.join(', ')}`);
  }
}