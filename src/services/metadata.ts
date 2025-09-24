// Metadata service that integrates ensnode, cache, and blockchain fallback
import { EnsnodeService, type EnsnodeDomain } from './ensnode';
import { CacheService, CacheKeys, CacheTTL } from './cache';
import { BlockchainService } from './blockchain';
import { ResolverService } from './resolver';
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
  cacheEnabled: boolean;
}

export class MetadataService {
  private ensnode: EnsnodeService;
  private cache: CacheService;
  private blockchain: BlockchainService;
  private resolver: ResolverService;

  constructor(
    config: MetadataServiceConfig,
    kv: KVNamespace,
    blockchainEnv: any
  ) {
    this.ensnode = new EnsnodeService({
      primaryEndpoint: config.ensnodeEndpoint,
      fallbackEndpoint: config.ensnodeFallbackEndpoint,
    });

    this.cache = new CacheService(kv);
    this.blockchain = new BlockchainService(blockchainEnv);
    this.resolver = new ResolverService(this.blockchain);
  }

  // Get metadata for a single domain
  async getMetadata(
    network: NetworkName,
    registryType: 'registry' | 'namewrapper',
    identifier: string
  ): Promise<MetadataResponse> {
    // Validate identifier as ENS name
    if (!validateEnsName(identifier)) {
      throw new Error('Invalid ENS name format');
    }

    const cacheKey = CacheKeys.domain(identifier);

    // Try cache first
    const cached = await this.cache.get<MetadataResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    let metadata: MetadataResponse;

    try {
      // Try ensnode first
      const { domain, usedFallback } = await this.ensnode.getDomain(identifier);

      if (domain) {
        metadata = await this.buildMetadataFromEnsnode(domain, network, registryType);

        // Cache with appropriate TTL
        const ttl = CacheTTL.forDomain(domain);
        await this.cache.set(cacheKey, metadata, { ttl });

        return metadata;
      }

      // Domain not found in ensnode, try blockchain fallback
      if (usedFallback) {
        console.warn(`Ensnode fallback used for ${identifier}`);
      }

    } catch (error) {
      console.error('Ensnode query failed:', error);
    }

    // Fallback to direct blockchain query
    try {
      const nameData = await this.resolver.resolveName(identifier, namehash(identifier), network);
      metadata = await this.buildMetadataFromBlockchain(nameData, registryType);

      // Cache with shorter TTL for blockchain-sourced data
      await this.cache.set(cacheKey, metadata, { ttl: CacheTTL.error });

      return metadata;
    } catch (error) {
      console.error('Blockchain fallback failed:', error);
      throw new Error(`Failed to resolve metadata for ${identifier}`);
    }
  }

  // Get migration status
  async getMigrationStatus(name: string): Promise<MigrationStatusResponse> {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    const cacheKey = CacheKeys.migrationStatus(name);

    // Try cache first
    const cached = await this.cache.get<MigrationStatusResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Query ensnode for migration status
      const { status } = await this.ensnode.getMigrationStatus(name);

      if (status) {
        const response: MigrationStatusResponse = {
          name,
          status: EnsnodeService.convertMigrationStatus(status),
          l1Owner: status.owner?.id,
          expirationDate: status.expiryDate,
        };

        // Cache the result
        await this.cache.set(cacheKey, response, { ttl: CacheTTL.normal });
        return response;
      }

      throw new Error('Migration status not found');
    } catch (error) {
      console.error('Migration status query failed:', error);

      // Fallback response
      const fallbackResponse: MigrationStatusResponse = {
        name,
        status: 'unmigrated',
      };

      // Cache briefly to avoid repeated failures
      await this.cache.set(cacheKey, fallbackResponse, { ttl: CacheTTL.error });
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
      // Query ensnode for hierarchy
      const { hierarchy } = await this.ensnode.getHierarchy(name);

      if (hierarchy) {
        const response = this.buildHierarchyResponse(hierarchy, name);

        // Cache the result
        await this.cache.set(cacheKey, response, { ttl: CacheTTL.normal });
        return response;
      }

      throw new Error('Hierarchy not found');
    } catch (error) {
      console.error('Hierarchy query failed:', error);

      // Generate basic hierarchy as fallback
      const fallbackResponse = this.generateBasicHierarchy(name);

      // Cache briefly
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

      // Return error response
      return {
        results: names.map(name => ({ name, error: 'Batch query failed' })),
        total: names.length,
        successful: 0,
        failed: names.length,
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

    return {
      name: domain.name,
      tokenId: domain.labelhash,
      version: domain.isMigrated ? 'v2' : 'v1',
      network,
      description: this.generateDescription(domain.name, domain.isMigrated || false),
      image: this.generateImageUrl(domain.name),
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

    return {
      name: nameData.name,
      tokenId: nameData.tokenId,
      version: nameData.version,
      network: nameData.network,
      description: this.generateDescription(nameData.name, nameData.version === 'v2'),
      image: this.generateImageUrl(nameData.name),
      attributes: this.buildAttributesFromBlockchain(nameData, label),
      external_url: `https://app.ens.domains/name/${nameData.name}`,
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
  private generateImageUrl(name: string): string {
    // TODO: Integrate with SVG generation service
    return `https://metadata.ens.domains/${name}/image`;
  }

  // Get domain level
  private getDomainLevel(name: string): number {
    return name.split('.').length;
  }

  // Health check for all services
  async healthCheck() {
    const [ensnodeHealth, blockchainHealth] = await Promise.all([
      this.ensnode.healthCheck().catch(() => ({ primary: false })),
      this.blockchain.healthCheck().catch(() => ({ mainnet: { primary: false }, namechain: { primary: false } })),
    ]);

    return {
      ensnode: ensnodeHealth.primary ? 'ok' : ('fallback' in ensnodeHealth && ensnodeHealth.fallback ? 'degraded' : 'error'),
      blockchain: {
        mainnet: blockchainHealth.mainnet.primary ? 'ok' : 'error',
        namechain: blockchainHealth.namechain.primary ? 'ok' : 'error',
      },
    };
  }
}