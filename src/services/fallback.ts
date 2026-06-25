// Fallback and retry logic for when ensnode is down
import type { EnsnodeService } from './ensnode';
import { type BlockchainService, CONTRACTS } from './blockchain';
import type { ResolverService } from './resolver';
import { namehash, validateEnsName, isEmptyAddress } from '../utils/ens';
import { type NetworkName } from '../types';
import { NotFoundError, UpstreamError } from './errors';

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
  source: 'ensnode' | 'ensnodeV1' | 'blockchain';
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
    private resolver: ResolverService,
    // Optional secondary v1 ENSNode indexer (e.g. sepolia v1 names absent from zigens).
    private ensnodeV1?: EnsnodeService,
  ) {}

  // Execute operation with automatic fallback logic
  async executeWithFallback<T>(
    operation: {
      ensnode: () => Promise<T>;
      ensnodeV1?: () => Promise<T>;
      blockchain: () => Promise<T>;
    },
    operationName: string
  ): Promise<FallbackResult<T>> {
    let lastError: Error | null = null;
    let retries = 0;
    let sawUpstream = false; // any tier hit a real upstream failure (vs a clean miss)

    // Try the primary (v2) indexer first if it's enabled and healthy
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
        // Only an actual upstream failure trips the circuit-breaker. A NotFoundError
        // (name genuinely absent from the v2 index) is a clean miss — fall through
        // to the next tier WITHOUT marking the healthy indexer as unhealthy.
        if (error instanceof UpstreamError) {
          sawUpstream = true;
          console.warn(`Ensnode ${operationName} upstream failure, tripping breaker:`, error);
          this.markEnsnodeUnhealthy();
        } else {
          console.log(`Ensnode ${operationName} miss (${(error as Error)?.message ?? 'not found'}), trying next tier`);
        }
        retries++;
      }
    }

    // Secondary: v1 ENSNode subgraph (for v1-only names not present in the v2 indexer)
    if (this.ensnodeV1 && operation.ensnodeV1) {
      try {
        const data = await operation.ensnodeV1();
        return {
          data,
          source: 'ensnodeV1',
          usedFallback: true,
          retries,
        };
      } catch (error) {
        lastError = error as Error;
        if (error instanceof UpstreamError) sawUpstream = true;
        const kind = error instanceof UpstreamError ? 'upstream failure' : 'miss';
        console.log(`v1 ENSNode ${operationName} ${kind}, falling back to blockchain:`, (error as Error)?.message);
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

    // All tiers exhausted. Preserve the error taxonomy: if any tier hit a real
    // upstream failure we cannot claim "not found" (→ UpstreamError/503); otherwise
    // every tier cleanly missed (→ NotFoundError/404).
    if (sawUpstream) {
      throw new UpstreamError(
        `All sources failed for ${operationName}: ${lastError?.message}`,
        { cause: lastError },
      );
    }
    throw new NotFoundError(`${operationName}: not found in any source`);
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
            throw new NotFoundError(`Domain ${name} not found in ensnode`);
          }
          return domain;
        },
        ensnodeV1: async () => {
          const { domain } = await this.ensnodeV1!.getDomain(name);
          if (!domain) {
            throw new NotFoundError(`Domain ${name} not found in v1 ensnode`);
          }
          return domain;
        },
        blockchain: async () => {
          const nameData = await this.resolver.resolveName(
            name,
            namehash(name),
            this.config.blockchain.preferredNetwork
          );
          // resolveName returns synthetic empty data for names with no registry
          // owner — i.e. unregistered/never-registered names. Treat that as a clean
          // miss so the endpoint 404s instead of fabricating metadata for a name
          // that doesn't exist.
          if (isEmptyAddress(nameData.resolver.owner ?? '')) {
            throw new NotFoundError(`${name} is not registered`);
          }
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
            // Deliberately omit `isMigrated`: an on-chain read cannot distinguish
            // native-vs-migrated (that lives only in the indexer). Classification of
            // a `blockchain`-sourced result is done via on-chain status, not this field.
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
            throw new NotFoundError(`Migration status for ${name} not found in ensnode`);
          }
          return status;
        },
        ensnodeV1: async () => {
          const { status } = await this.ensnodeV1!.getMigrationStatus(name);
          if (!status) {
            throw new NotFoundError(`Migration status for ${name} not found in v1 ensnode`);
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
            // Neutral placeholder; a `blockchain`-sourced migration status is decided
            // by the on-chain registry check (isUnmigratedName), NOT this field —
            // an on-chain read cannot prove native-vs-migrated.
            isMigrated: false,
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
            throw new NotFoundError(`Hierarchy for ${name} not found in ensnode`);
          }
          return hierarchy;
        },
        ensnodeV1: async () => {
          const { hierarchy } = await this.ensnodeV1!.getHierarchy(name);
          if (!hierarchy) {
            throw new NotFoundError(`Hierarchy for ${name} not found in v1 ensnode`);
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
              const defaultResolver = CONTRACTS[this.config.blockchain.preferredNetwork]?.resolver || '';
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