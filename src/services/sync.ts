// Sync service for storing ensnode data in D1 for fast local queries
import { D1Service } from './d1';
import { IndexerService, type IndexerDomain } from './indexer';
import { validateEnsName, canonicalizeName } from '../utils/ens';
import { MIGRATION_STATUS } from '../types';
import { classifyV2IndexerRecord } from '../utils/migration';

export interface SyncConfig {
  batchSize: number;
  syncInterval: number; // milliseconds
  staleThreshold: number; // milliseconds - how old data can be before re-sync
}

export interface SyncResult {
  operation: 'domains' | 'migration' | 'hierarchy';
  processed: number;
  stored: number;
  errors: number;
  duration: number;
  lastError?: string;
}

export class SyncService {
  constructor(
    private d1: D1Service,
    private indexerV2: IndexerService,
    private config: SyncConfig
  ) {}

  // Sync a single domain from ensnode to D1. `fetched` is the domain the caller
  // already read from the same indexer (getMetadata): it is stored as-is
  // instead of being queried again.
  async syncDomain(name: string, force: boolean = false, fetched?: IndexerDomain): Promise<SyncResult> {
    const startTime = Date.now();
    let processed = 0;
    let stored = 0;
    let errors = 0;
    let lastError: string | undefined;

    try {
      if (!validateEnsName(name)) {
        throw new Error(`Invalid ENS name: ${name}`);
      }

      // Check if we need to sync (unless forced)
      if (!force) {
        const existing = await this.d1.getDomain(name);
        if (existing && (Date.now() - existing.last_updated) < this.config.staleThreshold) {
          return {
            operation: 'domains',
            processed: 1,
            stored: 0,
            errors: 0,
            duration: Date.now() - startTime,
          };
        }
      }

      processed = 1;

      // Fetch from ensnode, unless the caller already has the domain
      const { domain, usedFallback } = fetched
        ? { domain: fetched, usedFallback: false }
        : await this.indexerV2.getDomain(name);

      if (domain) {
        await this.d1.storeDomain(domain, 'ensnode');
        stored = 1;

        // Also sync related data
        await this.syncDomainRelatedData(name, domain);

        console.log(`Synced domain ${name} to D1${usedFallback ? ' (used fallback)' : ''}`);
      } else {
        console.warn(`Domain ${name} not found in ensnode`);
      }

      await this.d1.updateSyncStatus('domains', true);

    } catch (error) {
      errors = 1;
      lastError = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to sync domain ${name}:`, error);
      await this.d1.updateSyncStatus('domains', false, lastError);
    }

    return {
      operation: 'domains',
      processed,
      stored,
      errors,
      duration: Date.now() - startTime,
      lastError,
    };
  }

  // Sync multiple domains in batch
  async syncDomainsBatch(names: string[], force: boolean = false): Promise<SyncResult> {
    const startTime = Date.now();
    let processed = 0;
    let stored = 0;
    let errors = 0;
    let lastError: string | undefined;

    try {
      const validNames = names.filter(name => validateEnsName(name));
      processed = validNames.length;

      if (validNames.length === 0) {
        throw new Error('No valid ENS names provided');
      }

      // Check which names need syncing (unless forced)
      let namesToSync = validNames;
      if (!force) {
        const existing = await this.d1.getDomains(validNames);
        const existingMap = new Map(existing.map(d => [d.name, d]));

        namesToSync = validNames.filter(name => {
          const record = existingMap.get(canonicalizeName(name));
          return !record || (Date.now() - record.last_updated) >= this.config.staleThreshold;
        });
      }

      if (namesToSync.length === 0) {
        return {
          operation: 'domains',
          processed,
          stored: 0,
          errors: 0,
          duration: Date.now() - startTime,
        };
      }

      // Fetch from ensnode in batch
      const { domains } = await this.indexerV2.getDomains(namesToSync);

      if (domains && domains.length > 0) {
        stored = await this.d1.storeDomains(domains, 'ensnode');

        // Sync related data for each domain
        for (const domain of domains) {
          try {
            await this.syncDomainRelatedData(domain.name, domain);
          } catch (error) {
            console.error(`Failed to sync related data for ${domain.name}:`, error);
          }
        }

        console.log(`Synced ${stored}/${domains.length} domains to D1`);
      }

      await this.d1.updateSyncStatus('domains', true);

    } catch (error) {
      errors = Math.max(1, processed);
      lastError = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to sync domains batch:', error);
      await this.d1.updateSyncStatus('domains', false, lastError);
    }

    return {
      operation: 'domains',
      processed,
      stored,
      errors,
      duration: Date.now() - startTime,
      lastError,
    };
  }

  // Sync migration status for a domain
  async syncMigrationStatus(name: string, force: boolean = false): Promise<SyncResult> {
    const startTime = Date.now();
    let processed = 0;
    let stored = 0;
    let errors = 0;
    let lastError: string | undefined;

    try {
      if (!validateEnsName(name)) {
        throw new Error(`Invalid ENS name: ${name}`);
      }

      // Check if we need to sync (unless forced)
      if (!force) {
        const existing = await this.d1.getMigrationStatus(name);
        if (existing && (Date.now() - existing.last_updated) < this.config.staleThreshold) {
          return {
            operation: 'migration',
            processed: 1,
            stored: 0,
            errors: 0,
            duration: Date.now() - startTime,
          };
        }
      }

      processed = 1;

      // Fetch from ensnode
      const { status } = await this.indexerV2.getMigrationStatus(name);

      if (status) {
        // v2 (zigens) dialect: classify for real — the record carries the v2
        // migration signals (isMigrated/owner/protocol). v1 subgraph dialect:
        // its isMigrated means the 2019 registrar migration, NOT v2, and
        // presence in the v1 subgraph proves nothing about v2 → store
        // 'unmigrated' (the safe legacy default).
        const migrationStatus = this.indexerV2.apiVersion === 'v2'
          ? classifyV2IndexerRecord(status)
          : MIGRATION_STATUS.UNMIGRATED;
        await this.d1.storeMigrationStatus(name, migrationStatus, {
          owner: status.owner?.id,
          expirationDate: status.expiryDate,
        });
        stored = 1;

        console.log(`Synced migration status for ${name} to D1 (${migrationStatus})`);
      } else {
        console.warn(`Migration status for ${name} not found in ensnode`);
      }

      await this.d1.updateSyncStatus('migration', true);

    } catch (error) {
      errors = 1;
      lastError = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to sync migration status for ${name}:`, error);
      await this.d1.updateSyncStatus('migration', false, lastError);
    }

    return {
      operation: 'migration',
      processed,
      stored,
      errors,
      duration: Date.now() - startTime,
      lastError,
    };
  }

  // Sync registry hierarchy for a domain
  async syncHierarchy(name: string, _force: boolean = false): Promise<SyncResult> {
    const startTime = Date.now();
    let processed = 0;
    let stored = 0;
    let errors = 0;
    let lastError: string | undefined;

    try {
      if (!validateEnsName(name)) {
        throw new Error(`Invalid ENS name: ${name}`);
      }

      processed = 1;

      // Fetch from ensnode
      const { hierarchy } = await this.indexerV2.getHierarchy(name);

      if (hierarchy) {
        // Convert ensnode hierarchy to D1 format
        const hierarchyLevels = this.convertHierarchyToLevels(hierarchy, name);

        await this.d1.storeHierarchy(name, hierarchyLevels);
        stored = 1;

        console.log(`Synced hierarchy for ${name} to D1 (${hierarchyLevels.length} levels)`);
      } else {
        console.warn(`Hierarchy for ${name} not found in ensnode`);
      }

      await this.d1.updateSyncStatus('hierarchy', true);

    } catch (error) {
      errors = 1;
      lastError = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to sync hierarchy for ${name}:`, error);
      await this.d1.updateSyncStatus('hierarchy', false, lastError);
    }

    return {
      operation: 'hierarchy',
      processed,
      stored,
      errors,
      duration: Date.now() - startTime,
      lastError,
    };
  }

  // Sync all data for a domain (metadata + migration + hierarchy)
  async syncDomainComplete(name: string, force: boolean = false): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    // Run all sync operations
    const [domainResult, migrationResult, hierarchyResult] = await Promise.allSettled([
      this.syncDomain(name, force),
      this.syncMigrationStatus(name, force),
      this.syncHierarchy(name, force),
    ]);

    if (domainResult.status === 'fulfilled') {
      results.push(domainResult.value);
    } else {
      results.push({
        operation: 'domains',
        processed: 1,
        stored: 0,
        errors: 1,
        duration: 0,
        lastError: domainResult.reason?.message || 'Domain sync failed',
      });
    }

    if (migrationResult.status === 'fulfilled') {
      results.push(migrationResult.value);
    } else {
      results.push({
        operation: 'migration',
        processed: 1,
        stored: 0,
        errors: 1,
        duration: 0,
        lastError: migrationResult.reason?.message || 'Migration sync failed',
      });
    }

    if (hierarchyResult.status === 'fulfilled') {
      results.push(hierarchyResult.value);
    } else {
      results.push({
        operation: 'hierarchy',
        processed: 1,
        stored: 0,
        errors: 1,
        duration: 0,
        lastError: hierarchyResult.reason?.message || 'Hierarchy sync failed',
      });
    }

    return results;
  }

  // Background sync for stale records
  async syncStaleRecords(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    try {
      // Find stale records for each operation type
      const [staleDomains, staleMigrations, staleHierarchies] = await Promise.all([
        this.d1.findStaleRecords('domains', this.config.staleThreshold),
        this.d1.findStaleRecords('migration', this.config.staleThreshold),
        this.d1.findStaleRecords('hierarchy', this.config.staleThreshold),
      ]);

      // Sync stale domains in batches
      if (staleDomains.length > 0) {
        for (let i = 0; i < staleDomains.length; i += this.config.batchSize) {
          const batch = staleDomains.slice(i, i + this.config.batchSize);
          const result = await this.syncDomainsBatch(batch, true);
          results.push(result);

          // Small delay between batches to avoid overwhelming ensnode
          if (i + this.config.batchSize < staleDomains.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      // Sync stale migrations
      for (const name of staleMigrations.slice(0, this.config.batchSize)) {
        const result = await this.syncMigrationStatus(name, true);
        results.push(result);
      }

      // Sync stale hierarchies
      for (const name of staleHierarchies.slice(0, this.config.batchSize)) {
        const result = await this.syncHierarchy(name, true);
        results.push(result);
      }

      console.log(`Background sync completed: ${staleDomains.length} domains, ${staleMigrations.length} migrations, ${staleHierarchies.length} hierarchies`);

    } catch (error) {
      console.error('Background sync failed:', error);
      results.push({
        operation: 'domains',
        processed: 0,
        stored: 0,
        errors: 1,
        duration: 0,
        lastError: error instanceof Error ? error.message : 'Background sync failed',
      });
    }

    return results;
  }

  // Helper: Convert ensnode hierarchy to level-based format for D1
  private convertHierarchyToLevels(hierarchy: any, rootName: string): Array<{
    name: string;
    owner: string;
    resolver: string;
    level: number;
  }> {
    const levels: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    let current = hierarchy;
    let level = rootName.split('.').length;

    // Walk up the hierarchy tree
    while (current) {
      // The ENS subgraph root node (above TLDs) has no name — skip it
      if (current.name) {
        levels.unshift({
          name: current.name,
          owner: current.owner?.id || '0x0000000000000000000000000000000000000000',
          resolver: current.resolver?.address || '0x0000000000000000000000000000000000000000',
          level,
        });
      }

      current = current.parent;
      level--;
    }

    return levels;
  }

  // Helper: Sync related data for a domain (migration + hierarchy)
  private async syncDomainRelatedData(name: string, _domain: IndexerDomain): Promise<void> {
    // Always sync migration status (v1 isMigrated is unreliable for v2 status)
    try {
      await this.syncMigrationStatus(name);
    } catch (error) {
      console.warn(`Failed to sync migration status for ${name}:`, error);
    }

    // Always sync hierarchy for domain structure
    try {
      await this.syncHierarchy(name);
    } catch (error) {
      console.warn(`Failed to sync hierarchy for ${name}:`, error);
    }
  }

  // Get sync statistics
  async getSyncStats(): Promise<{
    status: any[];
    recordCounts: { domains: number; migrations: number; hierarchies: number };
  }> {
    const [status, health] = await Promise.all([
      this.d1.getSyncStatus(),
      this.d1.healthCheck(),
    ]);

    // Get record counts
    const recordCounts = {
      domains: health.recordCount,
      migrations: 0, // Would need separate query
      hierarchies: 0, // Would need separate query
    };

    return {
      status,
      recordCounts,
    };
  }
}

// Default sync configuration
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  batchSize: 50,
  syncInterval: 300000, // 5 minutes
  staleThreshold: 3600000, // 1 hour
};