// Fallback and retry logic for when ensnode is down
import type { EnsnodeService } from './ensnode';
import { type BlockchainService, CONTRACTS } from './blockchain';
import type { ResolverService } from './resolver';
import { namehash, validateEnsName } from '../utils/ens';
import { MIGRATION_STATUS, type NetworkName } from '../types';

export interface FallbackConfig {
  maxRetries: number;
  retryDelayMs: number;
  exponentialBackoff: boolean;
  ensnode: {
    enabled: boolean;
    healthCheckIntervalMs: number;
  };
  blockchain: {
    enabled: boolean;
    preferredNetwork: NetworkName;
  };
}

export interface FallbackResult<T> {
  data: T;
  source: 'ensnode' | 'blockchain';
  usedFallback: boolean;
  retries: number;
  error?: Error;
}

export class FallbackService {
  private ensnodeHealthy: boolean = true;
  private lastHealthCheck: number = 0;

  constructor(
    private config: FallbackConfig,
    private ensnode: EnsnodeService,
    private blockchain: BlockchainService,
    private resolver: ResolverService
  ) {}

  // Execute operation with automatic fallback logic
  async executeWithFallback<T>(
    operation: {
      ensnode: () => Promise<T>;
      blockchain: () => Promise<T>;
    },
    operationName: string
  ): Promise<FallbackResult<T>> {
    let lastError: Error | null = null;
    let retries = 0;

    // Try ensnode first if it's enabled and healthy
    if (this.config.ensnode.enabled && this.isEnsnodeHealthy()) {
      try {
        const data = await operation.ensnode();
        return {
          data,
          source: 'ensnode',
          usedFallback: false,
          retries,
        };
      } catch (error) {
        lastError = error as Error;
        console.warn(`Ensnode ${operationName} failed, falling back to blockchain:`, error);
        this.markEnsnodeUnhealthy();
        retries++;
      }
    }

    // Fallback to blockchain if ensnode failed or is disabled
    // No retries here — BlockchainService.executeWithFallback already cycles through RPC endpoints
    if (this.config.blockchain.enabled) {
      try {
        const data = await operation.blockchain();
        return {
          data,
          source: 'blockchain',
          usedFallback: true,
          retries,
        };
      } catch (error) {
        lastError = error as Error;
        console.error(`Blockchain ${operationName} fallback failed:`, error);
        retries++;
      }
    }

    // All options exhausted
    throw new Error(
      `All fallback options exhausted for ${operationName}. Last error: ${lastError?.message}`
    );
  }

  // Check if ensnode is healthy based on recent request outcomes (no proactive health check query)
  private isEnsnodeHealthy(): boolean {
    // If marked unhealthy, respect the cooldown period before retrying
    if (!this.ensnodeHealthy) {
      const now = Date.now();
      if (now - this.lastHealthCheck < this.config.ensnode.healthCheckIntervalMs) {
        return false;
      }
      // Cooldown expired — optimistically try again
      console.log('Ensnode cooldown expired, will retry on next request');
      this.ensnodeHealthy = true;
    }

    return this.ensnodeHealthy;
  }

  // Mark ensnode as unhealthy
  private markEnsnodeUnhealthy(): void {
    this.ensnodeHealthy = false;
    this.lastHealthCheck = Date.now();
    console.warn('Marked ensnode as unhealthy, will retry in', this.config.ensnode.healthCheckIntervalMs, 'ms');
  }

  // Execute operation with retries
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === this.config.maxRetries) {
          break; // Max retries exceeded
        }

        const delay = this.config.exponentialBackoff
          ? this.config.retryDelayMs * Math.pow(2, attempt)
          : this.config.retryDelayMs;

        console.warn(`${operationName} attempt ${attempt + 1} failed, retrying in ${delay}ms:`, error);
        await this.sleep(delay);
      }
    }

    throw lastError || new Error(`Max retries exceeded for ${operationName}`);
  }

  // Domain metadata fallback
  async getDomainMetadata(name: string) {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    return this.executeWithFallback(
      {
        ensnode: async () => {
          const { domain } = await this.ensnode.getDomain(name);
          if (!domain) {
            throw new Error(`Domain ${name} not found in ensnode`);
          }
          return domain;
        },
        blockchain: async () => {
          const nameData = await this.resolver.resolveName(
            name,
            namehash(name),
            this.config.blockchain.preferredNetwork
          );
          return {
            id: namehash(name),
            name: nameData.name,
            labelName: name.split('.')[0],
            labelhash: namehash(name.split('.')[0]),
            parentId: namehash(name.split('.').slice(1).join('.')),
            ownerId: nameData.resolver.owner,
            resolverId: nameData.resolver.resolver,
            registrantId: nameData.resolver.registrant,
            owner: { id: nameData.resolver.owner },
            resolver: { address: nameData.resolver.resolver },
            registrant: nameData.resolver.registrant ? { id: nameData.resolver.registrant } : undefined,
            expiryDate: nameData.expirationDate?.toISOString(),
            createdAt: nameData.registrationDate?.toISOString(),
            ttl: undefined,
            isMigrated: nameData.migrationStatus === MIGRATION_STATUS.NATIVE,
          };
        },
      },
      'getDomain'
    );
  }

  // Migration status fallback
  async getMigrationStatus(name: string) {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    return this.executeWithFallback(
      {
        ensnode: async () => {
          const { status } = await this.ensnode.getMigrationStatus(name);
          if (!status) {
            throw new Error(`Migration status for ${name} not found in ensnode`);
          }
          return status;
        },
        blockchain: async () => {
          const nameData = await this.resolver.resolveName(
            name,
            namehash(name),
            this.config.blockchain.preferredNetwork
          );
          return {
            name,
            isMigrated: nameData.migrationStatus === MIGRATION_STATUS.NATIVE,
            ownerId: nameData.resolver.owner,
            resolverId: nameData.resolver.resolver,
            parentId: namehash(name.split('.').slice(1).join('.')),
            owner: { id: nameData.resolver.owner },
            resolver: { address: nameData.resolver.resolver },
            expiryDate: nameData.expirationDate?.toISOString(),
          };
        },
      },
      'getMigrationStatus'
    );
  }

  // Registry hierarchy fallback
  async getRegistryHierarchy(name: string) {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }

    return this.executeWithFallback(
      {
        ensnode: async () => {
          const { hierarchy } = await this.ensnode.getHierarchy(name);
          if (!hierarchy) {
            throw new Error(`Hierarchy for ${name} not found in ensnode`);
          }
          return hierarchy;
        },
        blockchain: async () => {
          const parts = name.split('.');
          const hierarchyItems = [];

          // Build hierarchy by resolving each level
          for (let i = parts.length - 1; i >= 0; i--) {
            const domainName = parts.slice(i).join('.');
            const node = namehash(domainName);

            try {
              const nameData = await this.resolver.resolveName(
                domainName,
                node,
                this.config.blockchain.preferredNetwork
              );

              hierarchyItems.push({
                name: domainName,
                ownerId: nameData.resolver.owner,
                resolverId: nameData.resolver.resolver,
                parentId: i === parts.length - 1 ? undefined : namehash(parts.slice(i + 1).join('.')),
                owner: { id: nameData.resolver.owner },
                resolver: { address: nameData.resolver.resolver },
              });
            } catch (error) {
              // If we can't resolve a level, create a placeholder
              const defaultResolver = CONTRACTS[this.config.blockchain.preferredNetwork as keyof typeof CONTRACTS]?.resolver || '';
              hierarchyItems.push({
                name: domainName,
                ownerId: '0x0000000000000000000000000000000000000000',
                resolverId: defaultResolver,
                parentId: i === parts.length - 1 ? undefined : namehash(parts.slice(i + 1).join('.')),
                owner: { id: '0x0000000000000000000000000000000000000000' },
                resolver: { address: defaultResolver },
              });
            }
          }

          return {
            name,
            ownerId: hierarchyItems[hierarchyItems.length - 1]?.ownerId,
            resolverId: hierarchyItems[hierarchyItems.length - 1]?.resolverId,
            parentId: hierarchyItems[hierarchyItems.length - 1]?.parentId,
            owner: hierarchyItems[hierarchyItems.length - 1]?.owner,
            resolver: hierarchyItems[hierarchyItems.length - 1]?.resolver,
            parent: hierarchyItems.length > 1 ? this.buildParentHierarchy(hierarchyItems.slice(0, -1)) : undefined,
          };
        },
      },
      'getHierarchy'
    );
  }

  // Build parent hierarchy recursively
  private buildParentHierarchy(items: any[]): any {
    if (items.length === 0) return undefined;

    const current = items[items.length - 1];
    return {
      ...current,
      parent: items.length > 1 ? this.buildParentHierarchy(items.slice(0, -1)) : undefined,
    };
  }

  // Get service status
  getStatus() {
    return {
      ensnode: {
        healthy: this.ensnodeHealthy,
        lastCheck: this.lastHealthCheck,
      },
      blockchain: {
        enabled: this.config.blockchain.enabled,
      },
      config: this.config,
    };
  }

  // Reset health status (for manual recovery)
  resetHealthStatus(): void {
    this.ensnodeHealthy = true;
    this.lastHealthCheck = 0;
    console.log('Fallback service health status reset');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Default fallback configuration
export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  exponentialBackoff: true,
  ensnode: {
    enabled: true,
    healthCheckIntervalMs: 60000, // 1 minute
  },
  blockchain: {
    enabled: true,
    preferredNetwork: 'mainnet',
  },
};