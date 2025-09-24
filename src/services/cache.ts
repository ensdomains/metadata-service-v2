// KV cache management for ensnode responses
import type { EnsnodeDomain } from "./ensnode";

export interface CacheOptions {
  ttl?: number;
  namespace?: string;
  compressionThreshold?: number;
}

export interface CachedResponse<T> {
  data: T;
  timestamp: number;
  ttl: number;
  compressed?: boolean;
}

export class CacheService {
  constructor(private kv: KVNamespace) {}

  // Store data in cache with TTL
  async set<T>(
    key: string,
    data: T,
    options: CacheOptions = {},
  ): Promise<void> {
    const {
      ttl = 300,
      namespace = "ensnode",
      compressionThreshold = 10000,
    } = options;

    const cacheKey = this.buildKey(namespace, key);
    const response: CachedResponse<T> = {
      data,
      timestamp: Date.now(),
      ttl,
    };

    let serialized = JSON.stringify(response);

    // Compress large responses
    if (serialized.length > compressionThreshold) {
      try {
        // Use gzip compression if available in CF Workers
        const compressed = await this.compress(serialized);
        if (compressed.length < serialized.length * 0.8) {
          serialized = compressed;
          response.compressed = true;
        }
      } catch (error) {
        console.warn("Compression failed, storing uncompressed:", error);
      }
    }

    await this.kv.put(cacheKey, serialized, {
      expirationTtl: ttl,
    });
  }

  // Get data from cache
  async get<T>(key: string, namespace: string = "ensnode"): Promise<T | null> {
    const cacheKey = this.buildKey(namespace, key);
    const cached = await this.kv.get(cacheKey);

    if (!cached) return null;

    try {
      let data = cached;

      // Decompress if needed
      if (cached.startsWith("compressed:")) {
        data = await this.decompress(cached.slice(11));
      }

      const response: CachedResponse<T> = JSON.parse(data);

      // Check if cache entry has expired (double-check beyond KV TTL)
      const age = Date.now() - response.timestamp;
      if (age > response.ttl * 1000) {
        // Clean up expired entry
        await this.delete(key, namespace);
        return null;
      }

      return response.data;
    } catch (error) {
      console.warn("Cache deserialization error:", error);
      // Clean up corrupted cache entry
      await this.delete(key, namespace);
      return null;
    }
  }

  // Delete cache entry
  async delete(key: string, namespace: string = "ensnode"): Promise<void> {
    const cacheKey = this.buildKey(namespace, key);
    await this.kv.delete(cacheKey);
  }

  // Delete multiple cache entries by prefix
  async deleteByPrefix(
    prefix: string,
    namespace: string = "ensnode",
  ): Promise<number> {
    const fullPrefix = this.buildKey(namespace, prefix);
    const list = await this.kv.list({ prefix: fullPrefix });

    const deletions = list.keys.map((key) => this.kv.delete(key.name));
    await Promise.all(deletions);

    return deletions.length;
  }

  // Get cache statistics
  async getStats(namespace: string = "ensnode"): Promise<{
    totalKeys: number;
    keysSample: string[];
    estimatedSize: number;
  }> {
    const prefix = this.buildKey(namespace, "");
    const list = await this.kv.list({ prefix, limit: 1000 });

    // Get size estimate from a sample of entries
    const sampleKeys = list.keys.slice(0, 10);
    let sampleSize = 0;

    for (const key of sampleKeys) {
      const value = await this.kv.get(key.name);
      if (value) {
        sampleSize += value.length;
      }
    }

    const avgSize = sampleKeys.length > 0 ? sampleSize / sampleKeys.length : 0;
    const estimatedSize = avgSize * list.keys.length;

    return {
      totalKeys: list.keys.length,
      keysSample: list.keys.slice(0, 5).map((k) => k.name),
      estimatedSize,
    };
  }

  // Build cache key with namespace
  private buildKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  // Compress string data
  private async compress(data: string): Promise<string> {
    // Placeholder for compression - CF Workers has limited compression options
    // In a real implementation, we might use CompressionStream if available
    try {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const stream = new CompressionStream("gzip");
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      writer.write(encoder.encode(data));
      writer.close();

      const chunks: Uint8Array[] = [];
      let result = await reader.read();

      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }

      // Convert to base64 string for KV storage
      const compressed = new Uint8Array(
        chunks.reduce((acc, chunk) => acc + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        compressed.set(chunk, offset);
        offset += chunk.length;
      }

      return "compressed:" + btoa(String.fromCharCode(...compressed));
    } catch (error) {
      throw new Error(`Compression failed: ${error}`);
    }
  }

  // Decompress string data
  private async decompress(compressed: string): Promise<string> {
    try {
      const binaryString = atob(compressed);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const stream = new DecompressionStream("gzip");
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      writer.write(bytes);
      writer.close();

      const chunks: Uint8Array[] = [];
      let result = await reader.read();

      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }

      const decompressed = new Uint8Array(
        chunks.reduce((acc, chunk) => acc + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        decompressed.set(chunk, offset);
        offset += chunk.length;
      }

      return new TextDecoder().decode(decompressed);
    } catch (error) {
      throw new Error(`Decompression failed: ${error}`);
    }
  }
}

// Cache key generators for different operations
export const CacheKeys = {
  domain: (name: string) => `domain:${name.toLowerCase()}`,
  domains: (names: string[]) =>
    `domains:${names
      .map((n) => n.toLowerCase())
      .sort()
      .join(",")}`,
  migrationStatus: (name: string) => `migration:${name.toLowerCase()}`,
  hierarchy: (name: string) => `hierarchy:${name.toLowerCase()}`,
  batch: (operation: string, hash: string) => `batch:${operation}:${hash}`,
  health: () => "health:status",
};

// Cache TTL helpers
export const CacheTTL = {
  // Long cache for stable migrated domains
  migrated: 3600, // 1 hour

  // Medium cache for normal domains
  normal: 300, // 5 minutes

  // Short cache for expiring domains
  expiring: 60, // 1 minute

  // Very short cache for temporary failures
  error: 30, // 30 seconds

  // Batch operation cache
  batch: 180, // 3 minutes

  // Health check cache
  health: 120, // 2 minutes

  // Calculate dynamic TTL based on domain status
  forDomain: (domain?: EnsnodeDomain): number => {
    if (!domain) return CacheTTL.error;

    if (domain.isMigrated) return CacheTTL.migrated;

    if (domain.expiryDate) {
      const expiry = new Date(domain.expiryDate).getTime();
      const now = Date.now();
      const daysUntilExpiry = (expiry - now) / (1000 * 60 * 60 * 24);

      if (daysUntilExpiry < 7) return CacheTTL.expiring;
      if (daysUntilExpiry < 30) return CacheTTL.normal / 2;
    }

    return CacheTTL.normal;
  },
};

// Cache warming utilities
export class CacheWarmer {
  constructor(
    private cache: CacheService,
    private ensnode: any, // EnsnodeService - avoiding circular import
  ) {}

  // Warm cache for popular domains
  async warmPopularDomains(domains: string[]): Promise<void> {
    const chunks = this.chunkArray(domains, 10);

    for (const chunk of chunks) {
      const promises = chunk.map(async (domain) => {
        try {
          const { data } = await this.ensnode.getDomain(domain);
          if (data) {
            const cacheKey = CacheKeys.domain(domain);
            const ttl = CacheTTL.forDomain(data);
            await this.cache.set(cacheKey, data, { ttl });
          }
        } catch (error) {
          console.warn(`Failed to warm cache for ${domain}:`, error);
        }
      });

      await Promise.all(promises);
      // Small delay between chunks to avoid overwhelming ensnode
      await this.sleep(100);
    }
  }

  // Invalidate cache for updated domains
  async invalidateDomain(name: string): Promise<void> {
    await Promise.all([
      this.cache.delete(CacheKeys.domain(name)),
      this.cache.delete(CacheKeys.migrationStatus(name)),
      this.cache.delete(CacheKeys.hierarchy(name)),
    ]);
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
