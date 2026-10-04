// Simplified KV cache management for internal ensnode response caching
// External API response caching is handled by Cloudflare native caching

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

// KV rejects an expirationTtl below 60 seconds (the put throws).
export const KV_MIN_EXPIRATION_TTL_SECS = 60;

// KV rejects keys longer than 512 bytes. NFC can expand a name that still
// passes MAX_ENS_NAME_LENGTH, so get/set/delete must not call KV with one.
export const KV_MAX_KEY_BYTES = 512;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function kvKeyWithinLimit(cacheKey: string): boolean {
  const bytes = utf8ByteLength(cacheKey);
  if (bytes <= KV_MAX_KEY_BYTES) return true;
  console.warn(
    `Cache key exceeds ${KV_MAX_KEY_BYTES} bytes (${bytes}); skipping KV`,
  );
  return false;
}

export class CacheService {
  constructor(private kv: KVNamespace) {}

  // Store data in cache with TTL (at least KV's minimum). Best-effort: a failed
  // write is logged, never thrown, so caching an answer cannot fail the request
  // that computed it.
  async set<T>(
    key: string,
    data: T,
    options: CacheOptions = {},
  ): Promise<void> {
    const {
      ttl = 300,
      namespace = "indexer",
      compressionThreshold = 10000,
    } = options;

    const cacheKey = this.buildKey(namespace, key);
    if (!kvKeyWithinLimit(cacheKey)) return;
    const response: CachedResponse<T> = {
      data,
      timestamp: Date.now(),
      ttl,
    };

    let serialized = JSON.stringify(response);

    // Compress large responses
    if (serialized.length > compressionThreshold) {
      try {
        const compressed = await this.compress(serialized);
        if (compressed.length < serialized.length * 0.8) {
          serialized = compressed;
          response.compressed = true;
        }
      } catch (error) {
        console.warn("Compression failed, storing uncompressed:", error);
      }
    }

    try {
      await this.kv.put(cacheKey, serialized, {
        expirationTtl: Math.max(KV_MIN_EXPIRATION_TTL_SECS, ttl),
      });
    } catch (error) {
      console.warn(`Cache write failed for ${cacheKey}:`, error);
    }
  }

  // Get data from cache
  async get<T>(key: string, namespace: string = "indexer"): Promise<T | null> {
    const cacheKey = this.buildKey(namespace, key);
    if (!kvKeyWithinLimit(cacheKey)) return null;
    const cached = await this.kv.get(cacheKey);

    if (!cached) {
      return null;
    }

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
  async delete(key: string, namespace: string = "indexer"): Promise<void> {
    const cacheKey = this.buildKey(namespace, key);
    if (!kvKeyWithinLimit(cacheKey)) return;
    await this.kv.delete(cacheKey);
  }

  // Delete multiple cache entries by prefix. Paginates the KV list cursor — a
  // single list() page caps at 1000 keys, so a non-paginated delete silently
  // strands everything beyond the first page.
  async deleteByPrefix(
    prefix: string,
    namespace: string = "indexer",
  ): Promise<number> {
    const fullPrefix = this.buildKey(namespace, prefix);
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const list = await this.kv.list({ prefix: fullPrefix, cursor });
      await Promise.all(list.keys.map((key) => this.kv.delete(key.name)));
      deleted += list.keys.length;
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    return deleted;
  }

  // Basic cache statistics
  async getStats(namespace: string = "indexer"): Promise<{
    totalKeys: number;
    keysSample: string[];
  }> {
    const prefix = this.buildKey(namespace, "");
    const list = await this.kv.list({ prefix, limit: 1000 });

    return {
      totalKeys: list.keys.length,
      keysSample: list.keys.slice(0, 5).map((k) => k.name),
    };
  }

  // Build cache key with namespace
  private buildKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  // Compress string data
  private async compress(data: string): Promise<string> {
    try {
      const encoder = new TextEncoder();
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

// NFC then lowercase, repeated to a fixed point. One pass is not idempotent:
// U+03AA U+0301 lowercases to a sequence whose NFC is U+0390. The webhook
// applies canonicalizeName and then CacheKeys, so a single pass makes the
// purge miss the key the read path wrote. Same two operations as
// canonicalizeName, not an import: test/indexer.test.ts mocks ../src/utils/ens.
function canonicalCacheName(name: string): string {
  let current = name;
  for (let i = 0; i < 8; i++) {
    const next = current.normalize("NFC").toLowerCase();
    if (next === current) return current;
    current = next;
  }
  return current;
}

// Cache key generators for internal operations
export const CacheKeys = {
  domain: (name: string, network: string) => `ensnode:${network}:domain:${canonicalCacheName(name)}`,
  domains: (names: string[], network: string) => `ensnode:${network}:batch:${names.map(n => canonicalCacheName(n)).sort().join(",")}`,
  migrationStatus: (name: string, network: string) => `ensnode:${network}:migration:${canonicalCacheName(name)}`,
  hierarchy: (name: string, network: string) => `ensnode:${network}:hierarchy:${canonicalCacheName(name)}`,
  health: (network: string) => `ensnode:${network}:health:status`,
};

// Cache TTL helpers for internal caching
export const CacheTTL = {
  // Short cache for internal ensnode responses
  ensnode: 300, // 5 minutes

  // Very short cache for health checks
  health: 60, // 1 minute

  // Short cache for errors
  error: 30, // 30 seconds
};