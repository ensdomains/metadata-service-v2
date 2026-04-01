import { CacheConfig } from '../types';

export class CacheManager {
  constructor(
    private kvMetadata: KVNamespace,
    private kvSvg: KVNamespace,
    private db: D1Database
  ) {}

  // Generate cache key for metadata
  generateMetadataKey(network: string, registryType: string, identifier: string): string {
    return `metadata:${network}:${registryType}:${identifier}`;
  }

  // Generate cache key for SVG
  generateSvgKey(name: string): string {
    return `svg:${name}`;
  }

  // Get metadata from KV cache
  async getMetadata(key: string): Promise<any | null> {
    const cached = await this.kvMetadata.get(key);
    if (!cached) return null;
    
    try {
      return JSON.parse(cached);
    } catch (error) {
      console.error('Failed to parse cached metadata:', error);
      return null;
    }
  }

  // Store metadata in KV cache
  async setMetadata(key: string, data: any, config: CacheConfig): Promise<void> {
    try {
      await this.kvMetadata.put(key, JSON.stringify(data), {
        expirationTtl: config.ttl
      });
    } catch (error) {
      console.error('Failed to cache metadata:', error);
    }
  }

  // Get SVG from KV cache
  async getSvg(key: string): Promise<string | null> {
    return await this.kvSvg.get(key);
  }

  // Store SVG in KV cache
  async setSvg(key: string, svg: string, ttl: number): Promise<void> {
    try {
      await this.kvSvg.put(key, svg, {
        expirationTtl: ttl
      });
    } catch (error) {
      console.error('Failed to cache SVG:', error);
    }
  }

  // Invalidate cache entry
  async invalidate(key: string, reason: string): Promise<void> {
    try {
      // Remove from KV
      await Promise.all([
        this.kvMetadata.delete(key),
        this.kvSvg.delete(key)
      ]);

      // Log invalidation
      await this.db.prepare(`
        INSERT INTO cache_invalidation (cache_key, reason, triggered_by)
        VALUES (?, ?, 'manual')
      `).bind(key, reason).run();
    } catch (error) {
      console.error('Failed to invalidate cache:', error);
    }
  }

  // Get cache configuration based on migration status
  getCacheConfig(migrationStatus: string): CacheConfig {
    switch (migrationStatus) {
      case 'native':
      case 'migrated':
        return { ttl: 24 * 60 * 60, layer: 'kv' }; // 24 hours
      case 'unmigrated':
        return { ttl: 5 * 60, layer: 'memory' }; // 5 minutes
      default:
        return { ttl: 60 * 60, layer: 'kv' }; // 1 hour default
    }
  }
}