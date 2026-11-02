// Fallback logic for when indexerV2 is down
import type { IndexerService, IndexerDomain, IndexerMigrationStatus } from './indexer';
import type { SharedBreakerState } from './breaker-state';
import { type BlockchainService, CONTRACTS } from './blockchain';
import type { ResolverService, NameData } from './resolver';
import { namehash, canonicalizeName, validateEnsName, isEmptyAddress } from '../utils/ens';
import { type NetworkName } from '../types';
import { NotFoundError, RequestDeadlineError, UpstreamError, InvalidNameError } from './errors';

// How many levels the registry-hierarchy blockchain tier resolves at once. A
// name can be up to MAX_NAME_LABELS deep: walking it one RPC round-trip after
// another is slow, and resolving every level at once would fan out against the
// RPC providers.
export const HIERARCHY_RESOLVE_CONCURRENCY = 4;

export interface FallbackConfig {
  indexerV2: {
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
  source: 'indexerV2' | 'indexerV1' | 'blockchain';
  usedFallback: boolean;
  /**
   * How many tiers were tried before `source` and fell through to the next one
   * (a clean miss or an upstream failure). 0 when the first tier tried
   * answered. A tier that did not run (disabled, circuit-breaker open) is not
   * counted. Not a retry count: each tier runs at most once per call.
   */
  fallthroughs: number;
  error?: Error;
  /**
   * True when the primary (v2) indexer tier actually ran to a definitive answer
   * for this request (returned data, or a clean not-found miss). False when the
   * tier was skipped (disabled / circuit-breaker open) or hit an upstream
   * failure. Callers use this to decide whether "absent from the v2 index" has
   * been PROVEN: an indexerV1-sourced result with v2Consulted=false must not be
   * blindly classified `unmigrated` — the name may well be on v2.
   */
  v2Consulted: boolean;
}

// One indexerV2 upstream failure trips the breaker in this isolate only: it may
// be a transient blip, or one input that makes the indexer error or run past
// its timeout, and sharing that would switch the v2 tier off for a whole
// location (and soon every location) for a full cooldown. The trip is shared
// with the other isolates (breaker-state.ts) only once this many upstream
// failures come in a row with no success between them, i.e. when the probe
// after a full cooldown fails too: an outage that outlasts a cooldown.
// Failures of requests already in flight when the breaker tripped belong to
// that trip and do not count again.
export const SHARED_TRIP_AFTER_FAILURES = 2;

// When an isolate adopts another isolate's trip it adds a random delay of up to
// this much to its own end of the trip, so the isolates do not all probe the
// indexer at the same instant when it ends. Local only: KV keeps the real end.
export const SHARED_TRIP_JITTER_MS = 10_000;

export class FallbackService {
  private indexerV2Healthy: boolean = true;
  private lastHealthCheck: number = 0;
  // indexerV2 upstream failures in a row, counted once per local trip.
  private consecutiveV2Failures = 0;

  constructor(
    private config: FallbackConfig,
    private indexerV2: IndexerService,
    private blockchain: BlockchainService,
    private resolver: ResolverService,
    // Optional secondary v1 ENSNode indexer (e.g. sepolia v1 names absent from zigens).
    private indexerV1?: IndexerService,
    // Optional cross-isolate state for the indexerV2 breaker (see breaker-state.ts).
    private sharedBreaker?: SharedBreakerState,
  ) {}

  // Execute operation with automatic fallback logic
  async executeWithFallback<T>(
    operation: {
      indexerV2: () => Promise<T>;
      indexerV1?: () => Promise<T>;
      blockchain: () => Promise<T>;
    },
    operationName: string
  ): Promise<FallbackResult<T>> {
    let lastError: Error | null = null;
    let fallthroughs = 0; // tiers tried before the one that answers (miss or failure)
    let sawUpstream = false; // any tier hit a real upstream failure (vs a clean miss)
    let v2Consulted = false; // v2 tier ran to a definitive answer (result or clean miss)

    // Try the primary (v2) indexer first if it's enabled and healthy. When the
    // circuit-breaker is open the tier is skipped entirely — v2Consulted then
    // stays false so downstream classification/404 decisions know the v2 index
    // was NOT actually checked.
    if (this.config.indexerV2.enabled && await this.isIndexerV2Healthy()) {
      try {
        const data = await operation.indexerV2();
        this.consecutiveV2Failures = 0;
        return {
          data,
          source: 'indexerV2',
          usedFallback: false,
          fallthroughs,
          v2Consulted: true,
        };
      } catch (error) {
        lastError = error as Error;
        // Only an actual upstream failure trips the circuit-breaker. A NotFoundError
        // (name genuinely absent from the v2 index) is a clean miss — fall through
        // to the next tier WITHOUT marking the healthy indexer as unhealthy.
        if (error instanceof RequestDeadlineError) {
          // Running out of the request's time is not the indexer's failure: no
          // answer for this request, but no reason to trip the breaker either.
          sawUpstream = true;
        } else if (error instanceof UpstreamError) {
          sawUpstream = true;
          console.warn(`IndexerV2 ${operationName} upstream failure, tripping breaker:`, error);
          await this.markIndexerV2Unhealthy();
        } else {
          // Only a clean miss proves the v2 index lacks the name. Any other
          // error is not an answer, so the final not-found must not be treated
          // as definitive.
          if (error instanceof NotFoundError) v2Consulted = true;
          // Not an outage (those are UpstreamErrors), so the failure streak ends.
          this.consecutiveV2Failures = 0;
          console.log(`IndexerV2 ${operationName} miss (${(error as Error)?.message ?? 'not found'}), trying next tier`);
        }
        fallthroughs++;
      }
    }

    // Secondary: v1 ENSNode subgraph (for v1-only names not present in the v2 indexer)
    if (this.indexerV1 && operation.indexerV1) {
      try {
        const data = await operation.indexerV1();
        return {
          data,
          source: 'indexerV1',
          usedFallback: true,
          fallthroughs,
          v2Consulted,
        };
      } catch (error) {
        lastError = error as Error;
        if (error instanceof UpstreamError) sawUpstream = true;
        const kind = error instanceof UpstreamError ? 'upstream failure' : 'miss';
        console.log(`v1 ENSNode ${operationName} ${kind}, falling back to blockchain:`, (error as Error)?.message);
        fallthroughs++;
      }
    }

    // Fallback to blockchain if indexerV2 failed or is disabled
    // No retries here — BlockchainService.executeWithFallback already cycles through RPC endpoints
    if (this.config.blockchain.enabled) {
      try {
        const data = await operation.blockchain();
        return {
          data,
          source: 'blockchain',
          usedFallback: true,
          fallthroughs,
          v2Consulted,
        };
      } catch (error) {
        lastError = error as Error;
        // A non-NotFound failure here means the CHAIN couldn't be read (RPCs
        // exhausted) — that is an upstream failure, not evidence of absence.
        // Without this, a total outage would fall through to a cacheable 404.
        if (!(error instanceof NotFoundError)) sawUpstream = true;
        console.error(`Blockchain ${operationName} fallback failed:`, error);
        fallthroughs++;
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
    // A skipped primary (disabled or breaker-open) was not consulted, so the
    // remaining clean misses are not proof of absence.
    throw new NotFoundError(`${operationName}: not found in any source`, {
      definitive: v2Consulted,
    });
  }

  // Check if indexerV2 is healthy based on recent request outcomes (no proactive health check query)
  private async isIndexerV2Healthy(): Promise<boolean> {
    // A trip shared by another isolate that ends later than this isolate's own
    // cooldown: adopt it, so this isolate skips the indexer until it ends too,
    // plus a random jitter so the isolates' next probes are spread out. An
    // adopted trip is no failure seen here: it does not count toward sharing.
    const sharedUntil = (await this.sharedBreaker?.trippedUntil()) ?? 0;
    const localUntil = this.indexerV2Healthy ? 0 : this.lastHealthCheck + this.config.indexerV2.healthCheckIntervalMs;
    if (sharedUntil > Date.now() && sharedUntil > localUntil) {
      const until = sharedUntil + Math.random() * SHARED_TRIP_JITTER_MS;
      this.indexerV2Healthy = false;
      this.lastHealthCheck = until - this.config.indexerV2.healthCheckIntervalMs;
      console.warn('IndexerV2 breaker tripped by another isolate, skipping until', new Date(until).toISOString());
    }

    // If marked unhealthy, respect the cooldown period before retrying
    if (!this.indexerV2Healthy) {
      const now = Date.now();
      if (now - this.lastHealthCheck < this.config.indexerV2.healthCheckIntervalMs) {
        return false;
      }
      // Cooldown expired — optimistically try again
      console.log('IndexerV2 cooldown expired, will retry on next request');
      this.indexerV2Healthy = true;
    }

    return this.indexerV2Healthy;
  }

  // Mark indexerV2 as unhealthy here, and for the other isolates once it has
  // failed SHARED_TRIP_AFTER_FAILURES times in a row
  private async markIndexerV2Unhealthy(): Promise<void> {
    // With the breaker already open this is a request that was in flight when
    // it tripped: the same trip, not another failure in a row.
    if (this.indexerV2Healthy) this.consecutiveV2Failures++;
    this.indexerV2Healthy = false;
    this.lastHealthCheck = Date.now();
    console.warn('Marked indexerV2 as unhealthy, will retry in', this.config.indexerV2.healthCheckIntervalMs, 'ms');
    if (this.consecutiveV2Failures >= SHARED_TRIP_AFTER_FAILURES) {
      await this.sharedBreaker?.trip(this.lastHealthCheck + this.config.indexerV2.healthCheckIntervalMs);
    }
  }

  // Domain metadata fallback
  async getDomainMetadata(name: string) {
    if (!validateEnsName(name)) {
      throw new InvalidNameError();
    }

    return this.executeWithFallback<IndexerDomain>(
      {
        indexerV2: async () => {
          const { domain } = await this.indexerV2.getDomain(name);
          // Only an explicit `domain: null` is the index answering "no such
          // name". A body without the field (e.g. a proxy or maintenance JSON
          // such as {"data":{}}) is not an answer: an upstream failure, as the
          // indexer client already reports it, never a not-found (503 when no
          // other tier has the name).
          if (domain === undefined) {
            throw new UpstreamError(`Malformed indexerV2 response for ${name}: no domain field`);
          }
          if (!domain) {
            throw new NotFoundError(`Domain ${name} not found in indexerV2`);
          }
          return domain;
        },
        indexerV1: async () => {
          const { domain } = await this.indexerV1!.getDomain(name);
          if (!domain) {
            throw new NotFoundError(`Domain ${name} not found in indexerV1`);
          }
          return domain;
        },
        blockchain: async () => {
          // resolveName is v2-aware: for a name REGISTERED in the live v2
          // registry it returns the v2 owner/resolver/expiry (a native-v2 name
          // has NO v1 registry owner, so the existence gate below would
          // otherwise 404 it).
          const nameData = await this.resolver.resolveName(
            name,
            namehash(name),
            this.config.blockchain.preferredNetwork
          );
          // resolveName returns synthetic empty data for names with no registry
          // owner (v1 OR v2) — i.e. unregistered/never-registered names. Treat
          // that as a clean miss so the endpoint 404s instead of fabricating
          // metadata for a name that doesn't exist.
          if (isEmptyAddress(nameData.resolver.owner ?? '')) {
            throw new NotFoundError(`${name} is not registered`);
          }
          return {
            id: namehash(name),
            name: canonicalizeName(nameData.name),
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
            // native-vs-migrated (that lives only in the indexer). Instead the
            // on-chain classification travels on chainMigrationStatus (below):
            // `unmigrated` (v1 registry) or `migrated` (REGISTERED on v2 — never
            // `native`, the chain can't prove provenance).
            chainMigrationStatus: nameData.migrationStatus,
          };
        },
      },
      'getDomain'
    );
  }

  // Migration status fallback
  async getMigrationStatus(name: string) {
    if (!validateEnsName(name)) {
      throw new InvalidNameError();
    }

    return this.executeWithFallback<IndexerMigrationStatus>(
      {
        indexerV2: async () => {
          const { status } = await this.indexerV2.getMigrationStatus(name);
          if (!status) {
            throw new NotFoundError(`Migration status for ${name} not found in indexerV2`);
          }
          return status;
        },
        indexerV1: async () => {
          const { status } = await this.indexerV1!.getMigrationStatus(name);
          if (!status) {
            throw new NotFoundError(`Migration status for ${name} not found in indexerV1`);
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
            // Neutral placeholder; a `blockchain`-sourced migration status travels
            // on chainMigrationStatus (from the v2-aware resolveName), NOT this
            // field — an on-chain read cannot prove native-vs-migrated.
            isMigrated: false,
            ownerId: nameData.resolver.owner,
            resolverId: nameData.resolver.resolver,
            parentId: namehash(name.split('.').slice(1).join('.')),
            owner: { id: nameData.resolver.owner },
            resolver: { address: nameData.resolver.resolver },
            expiryDate: nameData.expirationDate?.toISOString(),
            chainMigrationStatus: nameData.migrationStatus,
          };
        },
      },
      'getMigrationStatus'
    );
  }

  // Registry hierarchy fallback
  async getRegistryHierarchy(name: string) {
    if (!validateEnsName(name)) {
      throw new InvalidNameError();
    }

    return this.executeWithFallback(
      {
        indexerV2: async () => {
          const { hierarchy } = await this.indexerV2.getHierarchy(name);
          if (!hierarchy) {
            throw new NotFoundError(`Hierarchy for ${name} not found in indexerV2`);
          }
          return hierarchy;
        },
        indexerV1: async () => {
          const { hierarchy } = await this.indexerV1!.getHierarchy(name);
          if (!hierarchy) {
            throw new NotFoundError(`Hierarchy for ${name} not found in indexerV1`);
          }
          return hierarchy;
        },
        blockchain: async () => {
          const parts = name.split('.');
          const hierarchyItems = [];

          // Resolve the levels, TLD first, up to HIERARCHY_RESOLVE_CONCURRENCY at
          // a time. outcomes[k] is the level with the last k+1 labels (the final
          // one is the requested name). Levels are claimed in order and no new
          // level is claimed after an UpstreamError, so every level before a
          // failure has settled and the ordered pass below throws the same error
          // a sequential walk would.
          const outcomes: Array<{ nameData: NameData } | { error: unknown }> = [];
          let nextLevel = 0;
          let upstreamFailed = false;
          const resolveLevels = async () => {
            while (nextLevel < parts.length && !upstreamFailed) {
              const k = nextLevel++;
              const domainName = parts.slice(parts.length - 1 - k).join('.');
              try {
                const nameData = await this.resolver.resolveName(
                  domainName,
                  namehash(domainName),
                  this.config.blockchain.preferredNetwork
                );
                outcomes[k] = { nameData };
              } catch (error) {
                outcomes[k] = { error };
                if (error instanceof UpstreamError) upstreamFailed = true;
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(HIERARCHY_RESOLVE_CONCURRENCY, parts.length) }, resolveLevels)
          );

          // Build hierarchy from each level's outcome
          for (let i = parts.length - 1; i >= 0; i--) {
            const domainName = parts.slice(i).join('.');

            try {
              const outcome = outcomes[parts.length - 1 - i];
              if ('error' in outcome) throw outcome.error;
              const { nameData } = outcome;

              hierarchyItems.push({
                name: domainName,
                ownerId: nameData.resolver.owner,
                resolverId: nameData.resolver.resolver,
                parentId: i === parts.length - 1 ? undefined : namehash(parts.slice(i + 1).join('.')),
                owner: { id: nameData.resolver.owner },
                resolver: { address: nameData.resolver.resolver },
              });
            } catch (error) {
              // Chain unreadable → surface the outage; fabricating zero-owner
              // levels here would turn a total outage into a cacheable 200 of
              // made-up data (defeating the error taxonomy above).
              if (error instanceof UpstreamError) throw error;
              // The requested name itself failing is a real verdict (e.g. clean
              // miss → 404 via the taxonomy) — only ANCESTOR levels may degrade
              // to a placeholder so partial hierarchies still render.
              if (i === 0) throw error;
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
      indexerV2: {
        healthy: this.indexerV2Healthy,
        lastCheck: this.lastHealthCheck,
      },
      blockchain: {
        enabled: this.config.blockchain.enabled,
      },
      config: this.config,
    };
  }

  // Reset health status (for manual recovery). Clears the shared trip too;
  // isolates that already adopted it keep skipping until it ends.
  async resetHealthStatus(): Promise<void> {
    this.indexerV2Healthy = true;
    this.lastHealthCheck = 0;
    this.consecutiveV2Failures = 0;
    await this.sharedBreaker?.reset();
    console.log('Fallback service health status reset');
  }
}

// Default fallback configuration
export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  indexerV2: {
    enabled: true,
    healthCheckIntervalMs: 60000, // 1 minute
  },
  blockchain: {
    enabled: true,
    preferredNetwork: 'mainnet',
  },
};