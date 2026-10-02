// Endpoint-level metadata cache with stale-while-revalidate
// Sits in front of MetadataService to avoid repeated ensnode/blockchain calls
import type { MetadataResponse } from '../types/api';
import { MIGRATION_STATUS } from '../types';
import { canonicalizeName } from '../utils/ens';
import { SUPPORTED_NETWORKS } from '../config/networks';
import { NotFoundError } from './errors';
import { DomainExpiredError, isStaleD1Rescue } from './metadata';
import { CacheTTL } from '../utils/cache-headers';

interface MetadataCacheEntry {
  metadata: MetadataResponse;
  createdAt: number;   // epoch ms
  softTtl: number;     // seconds
  migrationStatus: string;
}

interface TtlConfig {
  softTtl: number;   // serve but revalidate
  hardTtl: number;   // KV expiration
}

export type MetadataCacheStatus = 'hit' | 'stale' | 'miss';

export interface MetadataCacheResult {
  metadata: MetadataResponse;
  cacheStatus: MetadataCacheStatus;
  ttlConfig: TtlConfig;
  /** Stale D1 rescue after a live-tier failure: short TTL, no ordinary KV write. */
  rescued?: boolean;
}

function buildCacheKey(network: string, registryType: string, identifier: string): string {
  // Canonical (case-insensitive) name so mixed-case requests share one entry and
  // the webhook's invalidation matches what the read path wrote.
  return `meta:${network}:${registryType}:${canonicalizeName(identifier)}`;
}

function getTtlConfig(migrationStatus: string): TtlConfig {
  switch (migrationStatus) {
    case MIGRATION_STATUS.NATIVE:
    case MIGRATION_STATUS.MIGRATED:
      // On v2 — stable, rarely changes.
      return { softTtl: 86400, hardTtl: 2592000 };   // 24h / 30 days
    case MIGRATION_STATUS.UNMIGRATED:
      // Legacy — may flip to v2 during migration.
      return { softTtl: 3600, hardTtl: 604800 };      // 1h / 7 days
    default:
      return { softTtl: 21600, hardTtl: 604800 };     // 6h / 7 days
  }
}

function extractMigrationStatus(metadata: MetadataResponse): string {
  const attr = metadata.attributes?.find(a => a.trait_type === 'Migration Status');
  return attr ? String(attr.value).toLowerCase() : MIGRATION_STATUS.UNMIGRATED;
}

export class MetadataCacheService {
  constructor(private kv: KVNamespace) {}

  async get(
    network: string,
    registryType: string,
    identifier: string,
    executionCtx: ExecutionContext,
    fetchMetadata: () => Promise<MetadataResponse>,
  ): Promise<MetadataCacheResult> {
    const cacheKey = buildCacheKey(network, registryType, identifier);
    const start = Date.now();

    // --- KV lookup ---
    try {
      const raw = await this.kv.get(cacheKey);
      if (raw) {
        const entry: MetadataCacheEntry = JSON.parse(raw);
        const ageSeconds = (Date.now() - entry.createdAt) / 1000;
        const ttlConfig = getTtlConfig(entry.migrationStatus);

        if (ageSeconds < entry.softTtl) {
          console.log(`[metadata-cache] HIT ${identifier} (${Date.now() - start}ms, age ${Math.round(ageSeconds)}s)`);
          return { metadata: entry.metadata, cacheStatus: 'hit', ttlConfig };
        }

        // Stale — return immediately, revalidate in background
        console.log(`[metadata-cache] STALE ${identifier} (${Date.now() - start}ms, age ${Math.round(ageSeconds)}s > softTtl ${entry.softTtl}s) → revalidating`);
        executionCtx.waitUntil(
          this.revalidate(cacheKey, fetchMetadata).catch((err) =>
            console.error(`[metadata-cache] background revalidate failed for ${identifier}:`, err),
          ),
        );
        return { metadata: entry.metadata, cacheStatus: 'stale', ttlConfig };
      }
    } catch (err) {
      console.error(`[metadata-cache] KV read error for ${cacheKey}:`, err);
    }

    // --- Cache miss: fetch from origin ---
    const metadata = await fetchMetadata();
    if (isStaleD1Rescue(metadata)) {
      // Outage rescue must not be stored as a healthy long-lived success.
      const ttlConfig = { softTtl: CacheTTL.error, hardTtl: CacheTTL.error };
      console.log(`[metadata-cache] MISS ${identifier} (${Date.now() - start}ms) → stale D1 rescue, skipping ordinary KV write`);
      return { metadata, cacheStatus: 'miss', ttlConfig, rescued: true };
    }
    const migrationStatus = extractMigrationStatus(metadata);
    const ttlConfig = getTtlConfig(migrationStatus);

    console.log(`[metadata-cache] MISS ${identifier} (${Date.now() - start}ms) → writing to KV`);

    // Write back in background
    executionCtx.waitUntil(
      this.writeKv(cacheKey, metadata, migrationStatus, ttlConfig).catch((err) =>
        console.error(`[metadata-cache] KV write failed for ${cacheKey}:`, err),
      ),
    );

    return { metadata, cacheStatus: 'miss', ttlConfig };
  }

  // Invalidate all metadata cache entries for a domain. Keys are deterministic
  // (`meta:{network}:{registryType}:{name}`), so delete the exact key set —
  // listing the whole `meta:` namespace breaks silently past 1000 keys (KV
  // list() page cap).
  async invalidate(name: string): Promise<void> {
    try {
      const canonical = canonicalizeName(name);
      const keys = SUPPORTED_NETWORKS.flatMap((network) =>
        (['registry', 'namewrapper'] as const).map(
          (registryType) => buildCacheKey(network, registryType, canonical),
        ),
      );
      await Promise.all(keys.map((k) => this.kv.delete(k)));
    } catch (err) {
      console.error(`[metadata-cache] invalidation failed for ${name}:`, err);
    }
  }

  private async revalidate(
    cacheKey: string,
    fetchMetadata: () => Promise<MetadataResponse>,
  ): Promise<void> {
    try {
      const metadata = await fetchMetadata();
      if (isStaleD1Rescue(metadata)) {
        // Keep a healthy entry rather than replacing it with an outage rescue.
        return;
      }
      const migrationStatus = extractMigrationStatus(metadata);
      const ttlConfig = getTtlConfig(migrationStatus);
      await this.writeKv(cacheKey, metadata, migrationStatus, ttlConfig);
    } catch (err) {
      // A definitive origin verdict must evict the stale entry, or a burned/
      // expired name keeps serving from KV until hardTtl (up to 30 days).
      // Transient upstream failures (UpstreamError) and a not-found that is not
      // definitive (the primary index was skipped, e.g. circuit breaker open)
      // keep the stale copy, which is the point of SWR.
      if ((err instanceof NotFoundError && err.definitive) || err instanceof DomainExpiredError) {
        console.warn(`[metadata-cache] evicting ${cacheKey} — origin verdict: ${(err as Error).message}`);
        await this.kv.delete(cacheKey);
        return;
      }
      throw err;
    }
  }

  private async writeKv(
    cacheKey: string,
    metadata: MetadataResponse,
    migrationStatus: string,
    ttlConfig: TtlConfig,
  ): Promise<void> {
    const entry: MetadataCacheEntry = {
      metadata,
      createdAt: Date.now(),
      softTtl: ttlConfig.softTtl,
      migrationStatus,
    };
    await this.kv.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: ttlConfig.hardTtl,
    });
  }
}
