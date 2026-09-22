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
import type { NetworkName } from '../config/networks';

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

export class D1Service {
  constructor(private db: D1Database, private network: NetworkName) {}

  // Domain operations
  async storeDomain(domain: IndexerDomain, dataSource: 'ensnode' | 'blockchain' = 'ensnode'): Promise<void> {
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

    await stmt.bind(
      record.network, record.id, record.name, record.label_name, record.labelhash,
      record.parent_id, record.owner_id, record.resolver_id, record.registrant_id,
      record.expiry_date, record.created_at, record.ttl, record.is_migrated ? 1 : 0,
      record.data_source, record.last_updated
    ).run();
  }

  async getDomain(name: string): Promise<D1DomainRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE network = ?1 AND name = ?2');
    const result = await stmt.bind(this.network, canonicalizeName(name)).first<D1DomainRecord>();

    if (result) {
      result.is_migrated = Boolean(result.is_migrated);
    }

    return result;
  }

  async getDomainById(id: string): Promise<D1DomainRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE network = ?1 AND id = ?2');
    const result = await stmt.bind(this.network, id).first<D1DomainRecord>();

    if (result) {
      result.is_migrated = Boolean(result.is_migrated);
    }

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

  async getMigrationStatus(name: string): Promise<D1MigrationRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM migration_status WHERE network = ?1 AND name = ?2');
    return await stmt.bind(this.network, canonicalizeName(name)).first<D1MigrationRecord>();
  }

  // Registry hierarchy operations
  async storeHierarchy(name: string, hierarchy: Array<{
    name: string;
    owner: string;
    resolver: string;
    level: number;
  }>): Promise<void> {
    const rootDomainId = namehash(canonicalizeName(name));

    // Clear existing hierarchy for this domain
    await this.db.prepare('DELETE FROM registry_hierarchy WHERE network = ?1 AND root_domain_id = ?2')
      .bind(this.network, rootDomainId).run();

    // Insert new hierarchy records
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

      await stmt.bind(
        record.network, record.id, record.name, record.owner, record.resolver, record.level,
        record.parent_id, record.root_domain_id, record.last_updated
      ).run();
    }
  }

  async getHierarchy(name: string): Promise<D1HierarchyRecord[]> {
    const rootDomainId = namehash(canonicalizeName(name));
    const stmt = this.db.prepare(`
      SELECT * FROM registry_hierarchy
      WHERE network = ?1 AND root_domain_id = ?2
      ORDER BY level ASC
    `);
    const result = await stmt.bind(this.network, rootDomainId).all<D1HierarchyRecord>();
    return result.results || [];
  }

  // Batch operations
  async storeDomains(domains: IndexerDomain[], dataSource: 'ensnode' | 'blockchain' = 'ensnode'): Promise<number> {
    let stored = 0;

    for (const domain of domains) {
      try {
        await this.storeDomain(domain, dataSource);
        stored++;
      } catch (error) {
        console.error(`Failed to store domain ${domain.name}:`, error);
      }
    }

    return stored;
  }

  async getDomains(names: string[]): Promise<D1DomainRecord[]> {
    if (names.length === 0) return [];

    const placeholders = names.map((_, i) => `?${i + 2}`).join(', ');
    const stmt = this.db.prepare(`SELECT * FROM domains WHERE network = ?1 AND name IN (${placeholders})`);
    const result = await stmt.bind(this.network, ...names.map(canonicalizeName)).all<D1DomainRecord>();

    return (result.results || []).map(record => ({
      ...record,
      is_migrated: Boolean(record.is_migrated)
    }));
  }

  // Sync status operations
  async updateSyncStatus(operation: 'domains' | 'migration' | 'hierarchy', success: boolean, error?: string): Promise<void> {
    const now = Date.now();

    // Upsert: the (network, operation) row is created on first sync, so there's
    // no need to seed per-network rows in the schema.
    const stmt = this.db.prepare(`
      INSERT INTO sync_status (
        network, operation, last_sync, last_successful_sync,
        sync_count, error_count, last_error
      ) VALUES (
        ?1, ?2, ?3, CASE WHEN ?4 THEN ?3 ELSE 0 END,
        1, CASE WHEN ?4 THEN 0 ELSE 1 END, ?5
      )
      ON CONFLICT(network, operation) DO UPDATE SET
        last_sync = ?3,
        last_successful_sync = CASE WHEN ?4 THEN ?3 ELSE sync_status.last_successful_sync END,
        sync_count = sync_status.sync_count + 1,
        error_count = CASE WHEN ?4 THEN sync_status.error_count ELSE sync_status.error_count + 1 END,
        last_error = ?5
    `);

    await stmt.bind(this.network, operation, now, success ? 1 : 0, error || null).run();
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

  // Cleanup old records
  async cleanup(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAge;
    let deletedCount = 0;

    // Clean domains
    const domainsStmt = this.db.prepare('DELETE FROM domains WHERE network = ?1 AND last_updated < ?2');
    const domainsResult = await domainsStmt.bind(this.network, cutoff).run();
    deletedCount += domainsResult.meta.changes || 0;

    // Clean migration status
    const migrationStmt = this.db.prepare('DELETE FROM migration_status WHERE network = ?1 AND last_updated < ?2');
    const migrationResult = await migrationStmt.bind(this.network, cutoff).run();
    deletedCount += migrationResult.meta.changes || 0;

    // Clean hierarchy
    const hierarchyStmt = this.db.prepare('DELETE FROM registry_hierarchy WHERE network = ?1 AND last_updated < ?2');
    const hierarchyResult = await hierarchyStmt.bind(this.network, cutoff).run();
    deletedCount += hierarchyResult.meta.changes || 0;

    return deletedCount;
  }
}