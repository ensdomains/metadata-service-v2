// Metadata service that integrates ensnode, internal KV cache, and blockchain fallback
import { EnsnodeService, type EnsnodeDomain } from './ensnode';
import { CacheService, CacheKeys, CacheTTL } from './cache';
import { BlockchainService } from './blockchain';
import { ResolverService } from './resolver';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from './fallback';
import { D1Service } from './d1';
import { SyncService, DEFAULT_SYNC_CONFIG } from './sync';
import type {
  MetadataResponse,
  MigrationStatusResponse,
  RegistryHierarchyResponse,
  BatchMetadataResponse,
} from '../types/api';
import type { NetworkName, MigrationStatus } from '../types';
import { validateEnsName, getLabel, isEthDomain, namehash, getCharacterSet, getSegmentLength } from '../utils/ens';

export interface MetadataServiceConfig {
  ensnodeEndpoint: string;
  ensnodeFallbackEndpoint?: string;
  fallbackToBlockchain: boolean;
  internalCacheEnabled: boolean; // KV cache for internal optimizations
  d1Enabled: boolean;
}

export class MetadataService {
  private ensnode: EnsnodeService;
  private internalCache?: CacheService; // For internal optimizations only
  private cache: CacheService; // Backwards compatibility
  private blockchain: BlockchainService;
  private resolver: ResolverService;
  private fallback: FallbackService;
  private d1?: D1Service;
  private sync?: SyncService;

  constructor(
    config: MetadataServiceConfig,
    kv: KVNamespace,
    blockchainEnv: any,
    db?: D1Database
  ) {
    this.ensnode = new EnsnodeService({
      primaryEndpoint: config.ensnodeEndpoint,
      fallbackEndpoint: config.ensnodeFallbackEndpoint,
    });

    // Initialize internal cache for ensnode responses if enabled
    if (config.internalCacheEnabled) {
      this.internalCache = new CacheService(kv);
      this.cache = this.internalCache; // Backwards compatibility
    } else {
      // Create a no-op cache for backwards compatibility
      this.cache = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        deleteByPrefix: async () => 0,
        getStats: async () => ({ totalKeys: 0, keysSample: [] })
      } as any;
    }

    this.blockchain = new BlockchainService(blockchainEnv);
    this.resolver = new ResolverService(this.blockchain);

    // Initialize fallback service with configuration
    this.fallback = new FallbackService(
      config.fallbackToBlockchain ? DEFAULT_FALLBACK_CONFIG : {
        ...DEFAULT_FALLBACK_CONFIG,
        blockchain: { ...DEFAULT_FALLBACK_CONFIG.blockchain, enabled: config.fallbackToBlockchain }
      },
      this.ensnode,
      this.blockchain,
      this.resolver
    );

    // Initialize D1 and sync services if enabled
    if (config.d1Enabled && db) {
      this.d1 = new D1Service(db);
      this.sync = new SyncService(this.d1, this.ensnode, DEFAULT_SYNC_CONFIG);
    }
  }

  // Get metadata for a single domain (no API response caching - CF handles this)
  async getMetadata(
    network: NetworkName,
    registryType: 'registry' | 'namewrapper',
    identifier: string
  ): Promise<MetadataResponse> {
    // Validate identifier as ENS name
    if (!validateEnsName(identifier)) {
      throw new Error('Invalid ENS name format');
    }

    try {
      // Use comprehensive fallback service (internally cached)
      const { data: domain, source, usedFallback } = await this.fallback.getDomainMetadata(identifier);

      let metadata: MetadataResponse;

      if (source === 'ensnode') {
        metadata = await this.buildMetadataFromEnsnode(domain as any, network, registryType);

        // Store in D1 if enabled
        if (this.d1 && this.sync) {
          await this.sync.syncDomain(identifier).catch(error =>
            console.warn(`Failed to sync ${identifier} to D1:`, error)
          );
        }
      } else {
        // Built from blockchain data
        metadata = await this.buildMetadataFromBlockchain(domain as any, registryType);
      }

      if (usedFallback) {
        console.warn(`Fallback to ${source} used for ${identifier}`);
      }

      return metadata;
    } catch (error) {
      // Try D1 as last resort if available
      if (this.d1) {
        try {
          const d1Record = await this.d1.getDomain(identifier);
          if (d1Record) {
            console.warn(`Using stale D1 data for ${identifier} due to all other sources failing`);

            // Convert D1 record to metadata
            const metadata = await this.buildMetadataFromD1Record(d1Record, network, registryType);
            return metadata;
          }
        } catch (d1Error) {
          console.error(`D1 fallback also failed for ${identifier}:`, d1Error);
        }
      }

      console.error(`All fallback options failed for ${identifier}:`, error);
      throw new Error(`Failed to resolve metadata for ${identifier}`);
    }
  }

  // Get migration status (CF cache handles API response caching)
  async getMigrationStatus(name: string): Promise<MigrationStatusResponse> {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    try {
      // Use comprehensive fallback service (internally cached)
      const { data: status, source, usedFallback } = await this.fallback.getMigrationStatus(name);

      let response: MigrationStatusResponse;

      if (source === 'ensnode') {
        response = {
          name,
          status: EnsnodeService.convertMigrationStatus(status as any),
          l1Owner: (status as any).owner?.id,
          expirationDate: (status as any).expiryDate,
        };
      } else {
        // Built from blockchain data
        response = {
          name,
          status: (status as any).isMigrated ? 'native' : 'unmigrated',
          l1Owner: (status as any).owner?.id,
          expirationDate: (status as any).expiryDate,
        };
      }

      if (usedFallback) {
        console.warn(`Fallback to ${source} used for migration status of ${name}`);
      }

      return response;
    } catch (error) {
      // Try D1 as last resort if available
      if (this.d1) {
        try {
          const d1Record = await this.d1.getMigrationStatus(name);
          if (d1Record) {
            console.warn(`Using stale D1 migration data for ${name} due to all other sources failing`);

            const fallbackResponse: MigrationStatusResponse = {
              name: d1Record.name,
              status: d1Record.status,
              l1Owner: d1Record.l1_owner,
              expirationDate: d1Record.expiration_date,
            };

            return fallbackResponse;
          }
        } catch (d1Error) {
          console.error(`D1 migration fallback also failed for ${name}:`, d1Error);
        }
      }

      console.error(`All fallback options failed for migration status of ${name}:`, error);

      // Last resort fallback response
      const fallbackResponse: MigrationStatusResponse = {
        name,
        status: 'unmigrated',
      };

      return fallbackResponse;
    }
  }

  // Get registry hierarchy
  async getRegistryHierarchy(name: string): Promise<RegistryHierarchyResponse> {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    const cacheKey = CacheKeys.hierarchy(name);

    // Try cache first
    const cached = await this.cache.get<RegistryHierarchyResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Use comprehensive fallback service
      const { data: hierarchy, source, usedFallback } = await this.fallback.getRegistryHierarchy(name);

      let response: RegistryHierarchyResponse;

      if (source === 'ensnode') {
        response = this.buildHierarchyResponse(hierarchy as any, name);
        // Cache with ensnode TTL for ensnode data
        await this.cache.set(cacheKey, response, { ttl: CacheTTL.ensnode });
      } else {
        // Built from blockchain data
        response = this.buildHierarchyResponseFromBlockchain(hierarchy as any, name);
        // Cache with shorter TTL for blockchain-sourced data
        await this.cache.set(cacheKey, response, { ttl: CacheTTL.error });
      }

      if (usedFallback) {
        console.warn(`Fallback to ${source} used for hierarchy of ${name}`);
      }

      return response;
    } catch (error) {
      // Try D1 as last resort if available
      if (this.d1) {
        try {
          const d1Records = await this.d1.getHierarchy(name);
          if (d1Records.length > 0) {
            console.warn(`Using stale D1 hierarchy data for ${name} due to all other sources failing`);

            const fallbackResponse: RegistryHierarchyResponse = {
              name,
              hierarchy: d1Records.map(record => ({
                name: record.name,
                owner: record.owner,
                resolver: record.resolver,
                level: record.level,
              })),
            };

            // Cache briefly to avoid repeated D1 queries
            await this.cache.set(cacheKey, fallbackResponse, { ttl: CacheTTL.error });
            return fallbackResponse;
          }
        } catch (d1Error) {
          console.error(`D1 hierarchy fallback also failed for ${name}:`, d1Error);
        }
      }

      console.error(`All fallback options failed for hierarchy of ${name}:`, error);

      // Generate basic hierarchy as last resort
      const fallbackResponse = this.generateBasicHierarchy(name);
      await this.cache.set(cacheKey, fallbackResponse, { ttl: CacheTTL.error });
      return fallbackResponse;
    }
  }

  // Get batch metadata
  async getBatchMetadata(names: string[], network?: NetworkName): Promise<BatchMetadataResponse> {
    // Validate all names
    const validNames = names.filter(name => validateEnsName(name));

    if (validNames.length === 0) {
      return {
        results: [],
        total: 0,
        successful: 0,
        failed: names.length,
      };
    }

    try {
      // Try batch query from ensnode
      const { domains } = await this.ensnode.getDomains(validNames);

      // Build results
      const results = await Promise.allSettled(
        validNames.map(async (name) => {
          const domain = domains.find(d => d.name === name);

          if (domain) {
            const metadata = await this.buildMetadataFromEnsnode(
              domain,
              network || 'namechain',
              'registry'
            );
            return { name, metadata };
          } else {
            // Try individual fallback for missing domains
            try {
              const metadata = await this.getMetadata(
                network || 'namechain',
                'registry',
                name
              );
              return { name, metadata };
            } catch (error) {
              return { name, error: `Failed to resolve ${name}` };
            }
          }
        })
      );

      // Process results
      const response: BatchMetadataResponse = {
        results: results.map(result => {
          if (result.status === 'fulfilled') {
            return result.value;
          } else {
            return { name: '', error: 'Processing failed' };
          }
        }),
        total: validNames.length,
        successful: results.filter(r => r.status === 'fulfilled' && !('error' in r.value)).length,
        failed: results.filter(r => r.status === 'rejected' || ('error' in (r as any).value)).length,
      };

      return response;
    } catch (error) {
      console.error('Batch metadata query failed:', error);

      // Try blockchain fallback for batch metadata
      console.warn('Falling back to individual blockchain queries for batch metadata');

      const fallbackResults = await Promise.allSettled(
        validNames.map(async (name) => {
          try {
            const metadata = await this.getMetadata(
              network || 'namechain',
              'registry',
              name
            );
            return { name, metadata };
          } catch (fallbackError) {
            return { name, error: `Failed to resolve ${name}` };
          }
        })
      );

      return {
        results: fallbackResults.map(result =>
          result.status === 'fulfilled' ? result.value : { name: '', error: 'Processing failed' }
        ),
        total: validNames.length,
        successful: fallbackResults.filter(r =>
          r.status === 'fulfilled' && !('error' in r.value)
        ).length,
        failed: fallbackResults.filter(r =>
          r.status === 'rejected' || ('error' in (r as any).value)
        ).length,
      };
    }
  }

  // Build metadata response from ensnode domain data
  private async buildMetadataFromEnsnode(
    domain: EnsnodeDomain,
    network: NetworkName,
    registryType: string
  ): Promise<MetadataResponse> {
    const label = getLabel(domain.name);
    const migrationStatus = EnsnodeService.convertMigrationStatus({
      name: domain.name,
      isMigrated: domain.isMigrated || false,
    });

    return {
      name: domain.name,
      tokenId: domain.labelhash,
      version: domain.isMigrated ? 'v2' : 'v1',
      network,
      description: this.generateDescription(domain.name, domain.isMigrated || false),
      image: this.generateImageUrl(domain.name, migrationStatus),
      attributes: this.buildAttributes(domain, label),
      external_url: `https://app.ens.domains/name/${domain.name}`,
    };
  }

  // Build metadata response from blockchain data
  private async buildMetadataFromBlockchain(
    nameData: any,
    registryType: string
  ): Promise<MetadataResponse> {
    const label = getLabel(nameData.name);
    const migrationStatus = nameData.version === 'v2' ? 'native' : 'unmigrated';

    return {
      name: nameData.name,
      tokenId: nameData.tokenId,
      version: nameData.version,
      network: nameData.network,
      description: this.generateDescription(nameData.name, nameData.version === 'v2'),
      image: this.generateImageUrl(nameData.name, migrationStatus),
      attributes: this.buildAttributesFromBlockchain(nameData, label),
      external_url: `https://app.ens.domains/name/${nameData.name}`,
    };
  }

  // Build metadata response from D1 record
  private async buildMetadataFromD1Record(
    record: any,
    network: NetworkName,
    registryType: string
  ): Promise<MetadataResponse> {
    const label = getLabel(record.name);
    const migrationStatus = record.is_migrated ? 'native' : 'unmigrated';

    return {
      name: record.name,
      tokenId: record.labelhash,
      version: record.is_migrated ? 'v2' : 'v1',
      network,
      description: this.generateDescription(record.name, record.is_migrated),
      image: this.generateImageUrl(record.name, migrationStatus),
      attributes: this.buildAttributesFromD1Record(record, label),
      external_url: `https://app.ens.domains/name/${record.name}`,
    };
  }

  // Build hierarchy response from ensnode data
  private buildHierarchyResponse(
    hierarchy: any,
    name: string
  ): RegistryHierarchyResponse {
    const levels: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    let current = hierarchy;
    let level = this.getDomainLevel(name);

    while (current) {
      levels.push({
        name: current.name,
        owner: current.owner?.id || '0x0000000000000000000000000000000000000000',
        resolver: current.resolver?.address || '0x0000000000000000000000000000000000000000',
        level,
      });

      current = current.parent;
      level--;
    }

    return {
      name,
      hierarchy: levels.reverse(), // Root first
    };
  }

  // Build hierarchy response from blockchain data
  private buildHierarchyResponseFromBlockchain(
    hierarchy: any,
    name: string
  ): RegistryHierarchyResponse {
    // The FallbackService returns a hierarchy object with parent chain
    const levels: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    let current = hierarchy;
    let level = this.getDomainLevel(name);

    while (current) {
      levels.push({
        name: current.name,
        owner: current.owner?.id || '0x0000000000000000000000000000000000000000',
        resolver: current.resolver?.address || '0x0000000000000000000000000000000000000000',
        level,
      });

      current = current.parent;
      level--;
    }

    return {
      name,
      hierarchy: levels.reverse(), // Root first
    };
  }

  // Generate basic hierarchy as fallback
  private generateBasicHierarchy(name: string): RegistryHierarchyResponse {
    const parts = name.split('.');
    const hierarchy: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    for (let i = parts.length - 1; i >= 0; i--) {
      const domainName = parts.slice(i).join('.');
      hierarchy.push({
        name: domainName,
        owner: '0x0000000000000000000000000000000000000000',
        resolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
        level: parts.length - i,
      });
    }

    return { name, hierarchy };
  }

  // Build attributes array
  private buildAttributes(domain: EnsnodeDomain, label: string) {
    const attributes = [
      { trait_type: 'Character Set', value: getCharacterSet(domain.name) },
      { trait_type: 'Length', value: getSegmentLength(domain.name) },
      { trait_type: 'Registration Date', value: domain.createdAt || 'Unknown' },
    ];

    if (domain.expiryDate) {
      attributes.push({
        trait_type: 'Expiration Date',
        value: new Date(domain.expiryDate).toISOString().split('T')[0],
      });
    }

    if (domain.isMigrated !== undefined) {
      attributes.push({
        trait_type: 'Migration Status',
        value: domain.isMigrated ? 'Migrated' : 'Unmigrated',
      });
    }

    return attributes;
  }

  // Build attributes from blockchain data
  private buildAttributesFromBlockchain(nameData: any, label: string) {
    return [
      { trait_type: 'Character Set', value: getCharacterSet(nameData.name) },
      { trait_type: 'Length', value: getSegmentLength(nameData.name) },
      { trait_type: 'Network', value: nameData.network },
      { trait_type: 'Registry Type', value: nameData.resolver?.isWrapped ? 'NameWrapper' : 'Registry' },
    ];
  }

  // Build attributes from D1 record
  private buildAttributesFromD1Record(record: any, label: string) {
    const attributes = [
      { trait_type: 'Character Set', value: getCharacterSet(record.name) },
      { trait_type: 'Length', value: getSegmentLength(record.name) },
      { trait_type: 'Data Source', value: record.data_source },
    ];

    if (record.created_at) {
      attributes.push({
        trait_type: 'Registration Date',
        value: new Date(record.created_at).toISOString().split('T')[0],
      });
    }

    if (record.expiry_date) {
      attributes.push({
        trait_type: 'Expiration Date',
        value: new Date(record.expiry_date).toISOString().split('T')[0],
      });
    }

    attributes.push({
      trait_type: 'Migration Status',
      value: record.is_migrated ? 'Migrated' : 'Unmigrated',
    });

    return attributes;
  }

  // Generate description text
  private generateDescription(name: string, isMigrated: boolean): string {
    const label = getLabel(name);
    const tld = name.substring(name.lastIndexOf('.') + 1);

    let description = `${label}.${tld}, an ENS name.`;

    if (isMigrated) {
      description += ' This name has been migrated to ENS v2.';
    }

    return description;
  }

  // Generate image URL
  private generateImageUrl(name: string, migrationStatus?: MigrationStatus): string {
    // Use current domain for image generation
    const baseUrl = 'https://metadata.ens.domains'; // TODO: Make configurable

    const params = new URLSearchParams();
    if (migrationStatus) {
      params.set('status', migrationStatus);
    }

    const queryString = params.toString();
    return `${baseUrl}/${encodeURIComponent(name)}/image${queryString ? `?${queryString}` : ''}`;
  }

  // Get domain level
  private getDomainLevel(name: string): number {
    return name.split('.').length;
  }

  // Get migration status from blockchain when ensnode is down
  private async getMigrationStatusFromBlockchain(name: string): Promise<MigrationStatusResponse> {
    try {
      const nameData = await this.resolver.resolveName(name, namehash(name), 'namechain');

      // Determine migration status based on where we found the data
      let status: MigrationStatus = 'unmigrated';

      if (nameData.network === 'namechain') {
        status = nameData.migrationStatus || 'native';
      } else if (nameData.network === 'mainnet') {
        status = 'unmigrated';
      }

      return {
        name,
        status,
        l1Owner: nameData.network === 'mainnet' ? nameData.resolver.owner : undefined,
        expirationDate: nameData.expirationDate?.toISOString(),
      };
    } catch (error) {
      console.error('Blockchain migration status resolution failed:', error);
      throw new Error(`Unable to determine migration status for ${name} from blockchain`);
    }
  }

  // Get registry hierarchy from blockchain when ensnode is down
  private async getHierarchyFromBlockchain(name: string): Promise<RegistryHierarchyResponse> {
    try {
      const parts = name.split('.');
      const hierarchy: Array<{
        name: string;
        owner: string;
        resolver: string;
        level: number;
      }> = [];

      // Build hierarchy by checking each level
      for (let i = parts.length - 1; i >= 0; i--) {
        const domainName = parts.slice(i).join('.');
        const level = parts.length - i;

        try {
          const nameData = await this.resolver.resolveName(domainName, namehash(domainName), 'namechain');

          hierarchy.push({
            name: domainName,
            owner: nameData.resolver.owner || '0x0000000000000000000000000000000000000000',
            resolver: nameData.resolver.resolver || '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
            level,
          });
        } catch (error) {
          // If we can't resolve a level, fill with defaults
          hierarchy.push({
            name: domainName,
            owner: '0x0000000000000000000000000000000000000000',
            resolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
            level,
          });
        }
      }

      return {
        name,
        hierarchy: hierarchy.reverse(), // Root first
      };
    } catch (error) {
      console.error('Blockchain hierarchy resolution failed:', error);
      throw new Error(`Unable to resolve hierarchy for ${name} from blockchain`);
    }
  }

  // Health check for all services
  async healthCheck() {
    const [ensnodeHealth, blockchainHealth, fallbackStatus, d1Health] = await Promise.all([
      this.ensnode.healthCheck().catch(() => ({ primary: false })),
      this.blockchain.healthCheck().catch(() => ({ mainnet: { primary: false }, namechain: { primary: false } })),
      Promise.resolve(this.fallback.getStatus()),
      this.d1?.healthCheck().catch(() => ({ connected: false, recordCount: 0 })),
    ]);

    return {
      ensnode: ensnodeHealth.primary ? 'ok' : ('fallback' in ensnodeHealth && ensnodeHealth.fallback ? 'degraded' : 'error'),
      blockchain: {
        mainnet: blockchainHealth.mainnet.primary ? 'ok' : 'error',
        namechain: blockchainHealth.namechain.primary ? 'ok' : 'error',
      },
      fallback: {
        ensnodeHealthy: fallbackStatus.ensnode.healthy,
        blockchainEnabled: fallbackStatus.blockchain.enabled,
        lastEnsnodeCheck: new Date(fallbackStatus.ensnode.lastCheck).toISOString(),
        maxRetries: fallbackStatus.config.maxRetries,
        retryDelay: fallbackStatus.config.retryDelayMs,
        exponentialBackoff: fallbackStatus.config.exponentialBackoff,
      },
      d1: d1Health ? {
        connected: d1Health.connected,
        recordCount: d1Health.recordCount,
        enabled: this.d1 !== undefined,
      } : {
        connected: false,
        recordCount: 0,
        enabled: false,
      },
    };
  }

  // Reset fallback service health status
  resetFallbackHealth() {
    this.fallback.resetHealthStatus();
  }

  // Sync operations (if D1 is enabled)
  async syncDomain(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.syncDomain(name, force);
  }

  async syncDomainsBatch(names: string[], force: boolean = false) {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.syncDomainsBatch(names, force);
  }

  async syncMigrationStatus(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.syncMigrationStatus(name, force);
  }

  async syncHierarchy(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.syncHierarchy(name, force);
  }

  async syncDomainComplete(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.syncDomainComplete(name, force);
  }

  async syncStaleRecords() {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.syncStaleRecords();
  }

  async getSyncStats() {
    if (!this.sync) {
      throw new Error('D1 sync is not enabled');
    }
    return await this.sync.getSyncStats();
  }

  // D1 cleanup
  async cleanupD1(maxAge?: number) {
    if (!this.d1) {
      throw new Error('D1 is not enabled');
    }
    return await this.d1.cleanup(maxAge);
  }

  // Check if D1 is enabled
  get d1Enabled(): boolean {
    return this.d1 !== undefined;
  }

  // Check if sync is enabled
  get syncEnabled(): boolean {
    return this.sync !== undefined;
  }

  // Cross-chain sync - compare ensnode data from both chains
  // Primarily used for monitoring migration contract behavior and debugging edge cases
  // Under normal ENS v2 operation, inconsistencies should be extremely rare
  async getCrossChainSync(name: string): Promise<{
    name: string;
    mainnet: {
      exists: boolean;
      metadata?: MetadataResponse;
      error?: string;
    };
    namechain: {
      exists: boolean;
      metadata?: MetadataResponse;
      error?: string;
    };
    consistent: boolean;
    differences: string[];
    recommendation: 'migrated' | 'unmigrated' | 'inconsistent' | 'error';
  }> {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    const results = {
      name,
      mainnet: { exists: false } as any,
      namechain: { exists: false } as any,
      consistent: false,
      differences: [] as string[],
      recommendation: 'error' as any,
    };

    // Try to resolve from both networks in parallel
    const [mainnetResult, namechainResult] = await Promise.allSettled([
      this.getMetadata('mainnet', 'registry', name).catch(error => ({ error: error.message })),
      this.getMetadata('namechain', 'registry', name).catch(error => ({ error: error.message })),
    ]);

    // Process mainnet result
    if (mainnetResult.status === 'fulfilled') {
      if ('error' in mainnetResult.value) {
        results.mainnet.error = mainnetResult.value.error;
      } else {
        results.mainnet.exists = true;
        results.mainnet.metadata = mainnetResult.value;
      }
    } else {
      results.mainnet.error = mainnetResult.reason?.message || 'Failed to resolve from mainnet';
    }

    // Process namechain result
    if (namechainResult.status === 'fulfilled') {
      if ('error' in namechainResult.value) {
        results.namechain.error = namechainResult.value.error;
      } else {
        results.namechain.exists = true;
        results.namechain.metadata = namechainResult.value;
      }
    } else {
      results.namechain.error = namechainResult.reason?.message || 'Failed to resolve from namechain';
    }

    // Determine consistency and differences
    if (results.mainnet.exists && results.namechain.exists) {
      const mainnetMeta = results.mainnet.metadata!;
      const namechainMeta = results.namechain.metadata!;

      // Compare key fields
      const differences: string[] = [];

      if (mainnetMeta.version !== namechainMeta.version) {
        differences.push(`version: mainnet=${mainnetMeta.version}, namechain=${namechainMeta.version}`);
      }

      if (mainnetMeta.tokenId !== namechainMeta.tokenId) {
        differences.push(`tokenId: mainnet=${mainnetMeta.tokenId}, namechain=${namechainMeta.tokenId}`);
      }

      // Compare attributes
      const mainnetMigrated = mainnetMeta.attributes?.find((a: any) => a.trait_type === 'Migration Status')?.value;
      const namechainMigrated = namechainMeta.attributes?.find((a: any) => a.trait_type === 'Migration Status')?.value;

      if (mainnetMigrated !== namechainMigrated) {
        differences.push(`migration status: mainnet=${mainnetMigrated}, namechain=${namechainMigrated}`);
      }

      results.differences = differences;
      results.consistent = differences.length === 0;

      // Determine recommendation
      if (results.consistent) {
        results.recommendation = namechainMeta.version === 'v2' ? 'migrated' : 'unmigrated';
      } else {
        results.recommendation = 'inconsistent';
      }
    } else if (results.namechain.exists && !results.mainnet.exists) {
      // Only exists on namechain - fully migrated
      results.recommendation = 'migrated';
      results.differences.push('domain only exists on namechain (fully migrated)');
    } else if (results.mainnet.exists && !results.namechain.exists) {
      // Only exists on mainnet - unmigrated
      results.recommendation = 'unmigrated';
      results.differences.push('domain only exists on mainnet (not migrated)');
    } else {
      // Doesn't exist on either chain or both failed
      results.recommendation = 'error';
      if (!results.mainnet.exists && !results.namechain.exists) {
        results.differences.push('domain not found on either chain');
      }
    }

    return results;
  }
}