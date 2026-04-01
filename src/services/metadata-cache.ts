// Endpoint-level metadata cache with stale-while-revalidate
// Sits in front of MetadataService to avoid repeated ensnode/blockchain calls
import type { MetadataResponse } from '../types/api';

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
}

function buildCacheKey(network: string, registryType: string, identifier: string): string {
  return `meta:${network}:${registryType}:${identifier}`;
}

function getTtlConfig(migrationStatus: string): TtlConfig {
  switch (migrationStatus) {
    case 'native':
    case 'migrated':
      return { softTtl: 21600, hardTtl: 86400 };   // 6h / 24h
    case 'unmigrated':
      return { softTtl: 300, hardTtl: 1800 };       // 5m / 30m
    default:
      return { softTtl: 3600, hardTtl: 21600 };     // 1h / 6h
  }
}

function extractMigrationStatus(metadata: MetadataResponse): string {
  const attr = metadata.attributes?.find(a => a.trait_type === 'Migration Status');
  return attr ? String(attr.value).toLowerCase() : 'unmigrated';
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

  // Invalidate all metadata cache entries for a domain
  async invalidate(name: string): Promise<void> {
    try {
      const prefix = `meta:`;
      const list = await this.kv.list({ prefix });
      // Delete entries that contain this domain name
      const matching = list.keys.filter(k => k.name.endsWith(`:${name}`));
      if (matching.length > 0) {
        await Promise.all(matching.map(k => this.kv.delete(k.name)));
      }
    } catch (err) {
      console.error(`[metadata-cache] invalidation failed for ${name}:`, err);
    }
  }

  private async revalidate(
    cacheKey: string,
    fetchMetadata: () => Promise<MetadataResponse>,
  ): Promise<void> {
    const metadata = await fetchMetadata();
    const migrationStatus = extractMigrationStatus(metadata);
    const ttlConfig = getTtlConfig(migrationStatus);
    await this.writeKv(cacheKey, metadata, migrationStatus, ttlConfig);
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
