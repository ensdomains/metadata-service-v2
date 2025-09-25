// D1 service for local ensnode data storage and fast queries
import { namehash } from '../utils/ens';
import type { EnsnodeDomain } from './ensnode';
import type { MigrationStatus, NetworkName } from '../types';
import type {
  MetadataResponse,
  MigrationStatusResponse,
  RegistryHierarchyResponse,
} from '../types/api';

export interface D1DomainRecord {
  id: string; // namehash
  name: string;
  label_name: string;
  labelhash: string;
  parent_id?: string;
  owner_id?: string;
  resolver_id?: string;
  registrant_id?: string;
  expiry_date?: string;
  created_at?: string;
  ttl?: number;
  is_migrated: boolean;
  data_source: 'ensnode' | 'blockchain';
  last_updated: number;
  sync_version: number;
}

export interface D1MigrationRecord {
  id: string; // namehash
  name: string;
  status: MigrationStatus;
  l1_owner?: string;
  expiration_date?: string;
  migration_date?: string;
  last_updated: number;
  sync_version: number;
}

export interface D1HierarchyRecord {
  id: string; // namehash
  name: string;
  owner: string;
  resolver: string;
  level: number;
  parent_id?: string;
  root_domain_id: string;
  last_updated: number;
  sync_version: number;
}

export interface D1SyncStatus {
  operation: 'domains' | 'migration' | 'hierarchy';
  last_sync: number;
  last_successful_sync: number;
  sync_count: number;
  error_count: number;
  last_error?: string;
}

export class D1Service {
  constructor(private db: D1Database) {}

  // Domain operations
  async storeDomain(domain: EnsnodeDomain, dataSource: 'ensnode' | 'blockchain' = 'ensnode'): Promise<void> {
    const record: Omit<D1DomainRecord, 'sync_version'> = {
      id: namehash(domain.name),
      name: domain.name,
      label_name: domain.labelName || domain.name.split('.')[0],
      labelhash: domain.labelhash || namehash(domain.name.split('.')[0]),
      parent_id: domain.parentId,
      owner_id: domain.ownerId,
      resolver_id: domain.resolverId,
      registrant_id: domain.registrantId,
      expiry_date: domain.expiryDate,
      created_at: domain.createdAt,
      ttl: domain.ttl || undefined,
      is_migrated: domain.isMigrated || false,
      data_source: dataSource,
      last_updated: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO domains (
        id, name, label_name, labelhash, parent_id, owner_id, resolver_id,
        registrant_id, expiry_date, created_at, ttl, is_migrated,
        data_source, last_updated, sync_version
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        COALESCE((SELECT sync_version FROM domains WHERE id = ?1), 0) + 1
      )
    `);

    await stmt.bind(
      record.id, record.name, record.label_name, record.labelhash,
      record.parent_id, record.owner_id, record.resolver_id, record.registrant_id,
      record.expiry_date, record.created_at, record.ttl, record.is_migrated ? 1 : 0,
      record.data_source, record.last_updated
    ).run();
  }

  async getDomain(name: string): Promise<D1DomainRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE name = ?1');
    const result = await stmt.bind(name).first<D1DomainRecord>();

    if (result) {
      result.is_migrated = Boolean(result.is_migrated);
    }

    return result;
  }

  async getDomainById(id: string): Promise<D1DomainRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM domains WHERE id = ?1');
    const result = await stmt.bind(id).first<D1DomainRecord>();

    if (result) {
      result.is_migrated = Boolean(result.is_migrated);
    }

    return result;
  }

  // Migration status operations
  async storeMigrationStatus(name: string, status: MigrationStatus, data: {
    l1Owner?: string;
    expirationDate?: string;
    migrationDate?: string;
  }): Promise<void> {
    const record: Omit<D1MigrationRecord, 'sync_version'> = {
      id: namehash(name),
      name,
      status,
      l1_owner: data.l1Owner,
      expiration_date: data.expirationDate,
      migration_date: data.migrationDate,
      last_updated: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO migration_status (
        id, name, status, l1_owner, expiration_date, migration_date,
        last_updated, sync_version
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7,
        COALESCE((SELECT sync_version FROM migration_status WHERE id = ?1), 0) + 1
      )
    `);

    await stmt.bind(
      record.id, record.name, record.status, record.l1_owner,
      record.expiration_date, record.migration_date, record.last_updated
    ).run();
  }

  async getMigrationStatus(name: string): Promise<D1MigrationRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM migration_status WHERE name = ?1');
    return await stmt.bind(name).first<D1MigrationRecord>();
  }

  // Registry hierarchy operations
  async storeHierarchy(name: string, hierarchy: Array<{
    name: string;
    owner: string;
    resolver: string;
    level: number;
  }>): Promise<void> {
    const rootDomainId = namehash(name);

    // Clear existing hierarchy for this domain
    await this.db.prepare('DELETE FROM registry_hierarchy WHERE root_domain_id = ?1')
      .bind(rootDomainId).run();

    // Insert new hierarchy records
    for (const level of hierarchy) {
      const record: Omit<D1HierarchyRecord, 'sync_version'> = {
        id: namehash(level.name),
        name: level.name,
        owner: level.owner,
        resolver: level.resolver,
        level: level.level,
        parent_id: level.level > 1 ? namehash(hierarchy.find(h => h.level === level.level - 1)?.name || '') : undefined,
        root_domain_id: rootDomainId,
        last_updated: Date.now(),
      };

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO registry_hierarchy (
          id, name, owner, resolver, level, parent_id, root_domain_id,
          last_updated, sync_version
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          COALESCE((SELECT sync_version FROM registry_hierarchy WHERE id = ?1), 0) + 1
        )
      `);

      await stmt.bind(
        record.id, record.name, record.owner, record.resolver, record.level,
        record.parent_id, record.root_domain_id, record.last_updated
      ).run();
    }
  }

  async getHierarchy(name: string): Promise<D1HierarchyRecord[]> {
    const rootDomainId = namehash(name);
    const stmt = this.db.prepare(`
      SELECT * FROM registry_hierarchy
      WHERE root_domain_id = ?1
      ORDER BY level ASC
    `);
    const result = await stmt.bind(rootDomainId).all<D1HierarchyRecord>();
    return result.results || [];
  }

  // Batch operations
  async storeDomains(domains: EnsnodeDomain[], dataSource: 'ensnode' | 'blockchain' = 'ensnode'): Promise<number> {
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

    const placeholders = names.map((_, i) => `?${i + 1}`).join(', ');
    const stmt = this.db.prepare(`SELECT * FROM domains WHERE name IN (${placeholders})`);
    const result = await stmt.bind(...names).all<D1DomainRecord>();

    return (result.results || []).map(record => ({
      ...record,
      is_migrated: Boolean(record.is_migrated)
    }));
  }

  // Sync status operations
  async updateSyncStatus(operation: 'domains' | 'migration' | 'hierarchy', success: boolean, error?: string): Promise<void> {
    const now = Date.now();

    const stmt = this.db.prepare(`
      UPDATE sync_status SET
        last_sync = ?2,
        last_successful_sync = CASE WHEN ?3 THEN ?2 ELSE last_successful_sync END,
        sync_count = sync_count + 1,
        error_count = CASE WHEN ?3 THEN error_count ELSE error_count + 1 END,
        last_error = ?4
      WHERE operation = ?1
    `);

    await stmt.bind(operation, now, success ? 1 : 0, error || null).run();
  }

  async getSyncStatus(operation?: 'domains' | 'migration' | 'hierarchy'): Promise<D1SyncStatus[]> {
    let stmt;
    if (operation) {
      stmt = this.db.prepare('SELECT * FROM sync_status WHERE operation = ?1');
      const result = await stmt.bind(operation).all<D1SyncStatus>();
      return result.results || [];
    } else {
      stmt = this.db.prepare('SELECT * FROM sync_status ORDER BY operation');
      const result = await stmt.bind().all<D1SyncStatus>();
      return result.results || [];
    }
  }

  // Cache-like operations for fast lookups
  async findStaleRecords(operation: 'domains' | 'migration' | 'hierarchy', maxAge: number): Promise<string[]> {
    const cutoff = Date.now() - maxAge;

    let stmt;
    switch (operation) {
      case 'domains':
        stmt = this.db.prepare('SELECT name FROM domains WHERE last_updated < ?1');
        break;
      case 'migration':
        stmt = this.db.prepare('SELECT name FROM migration_status WHERE last_updated < ?1');
        break;
      case 'hierarchy':
        stmt = this.db.prepare('SELECT DISTINCT name FROM registry_hierarchy WHERE last_updated < ?1');
        break;
    }

    const result = await stmt.bind(cutoff).all<{ name: string }>();
    return (result.results || []).map(r => r.name);
  }

  // Health check
  async healthCheck(): Promise<{ connected: boolean; recordCount: number }> {
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM domains');
      const result = await stmt.first<{ count: number }>();

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
    const domainsStmt = this.db.prepare('DELETE FROM domains WHERE last_updated < ?1');
    const domainsResult = await domainsStmt.bind(cutoff).run();
    deletedCount += domainsResult.meta.changes || 0;

    // Clean migration status
    const migrationStmt = this.db.prepare('DELETE FROM migration_status WHERE last_updated < ?1');
    const migrationResult = await migrationStmt.bind(cutoff).run();
    deletedCount += migrationResult.meta.changes || 0;

    // Clean hierarchy
    const hierarchyStmt = this.db.prepare('DELETE FROM registry_hierarchy WHERE last_updated < ?1');
    const hierarchyResult = await hierarchyStmt.bind(cutoff).run();
    deletedCount += hierarchyResult.meta.changes || 0;

    return deletedCount;
  }
}