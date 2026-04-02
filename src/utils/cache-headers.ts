// Cloudflare cache header utilities
// Uses CF native caching instead of redundant KV layer

export interface CacheHeaderOptions {
  ttl: number; // seconds
  tags?: string[];
  priority?: 'high' | 'normal' | 'low';
  staleWhileRevalidate?: number;
}

// Cache TTL constants
export const CacheTTL = {
  // Long cache for stable migrated domains
  migrated: 3600, // 1 hour

  // Medium cache for normal domains
  normal: 300, // 5 minutes

  // Short cache for expiring domains
  expiring: 60, // 1 minute

  // Very short cache for temporary failures
  error: 30, // 30 seconds

  // Health check cache
  health: 120, // 2 minutes

};

// Generate appropriate cache headers for Cloudflare
export function getCacheHeaders(options: CacheHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {};

  // Set Cache-Control with TTL
  const cacheControl = [`public`, `max-age=${options.ttl}`];

  if (options.staleWhileRevalidate) {
    cacheControl.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  }

  headers['Cache-Control'] = cacheControl.join(', ');

  // Set CF cache tags for invalidation
  if (options.tags && options.tags.length > 0) {
    headers['Cache-Tag'] = options.tags.join(',');
  }

  // Set CF cache priority (if supported)
  if (options.priority) {
    headers['CF-Cache-Priority'] = options.priority;
  }

  return headers;
}

// Cache header presets for different response types
export const CachePresets = {
  // Migration status
  migrationStatus: (name: string): Record<string, string> =>
    getCacheHeaders({
      ttl: CacheTTL.normal,
      tags: ['migration', `domain:${name}`],
      priority: 'normal',
      staleWhileRevalidate: 30,
    }),

  // Registry hierarchy
  hierarchy: (name: string): Record<string, string> =>
    getCacheHeaders({
      ttl: CacheTTL.normal,
      tags: ['hierarchy', `domain:${name}`],
      priority: 'normal',
      staleWhileRevalidate: 60,
    }),

  // Health check
  health: (): Record<string, string> =>
    getCacheHeaders({
      ttl: CacheTTL.health,
      tags: ['health'],
      priority: 'low',
    }),

  // Error responses
  error: (): Record<string, string> =>
    getCacheHeaders({
      ttl: CacheTTL.error,
      tags: ['error'],
      priority: 'low',
    }),

  // Blockchain fallback data (low reliability)
  blockchainFallback: (name: string): Record<string, string> =>
    getCacheHeaders({
      ttl: CacheTTL.error,
      tags: ['blockchain', 'fallback', `domain:${name}`],
      priority: 'low',
    }),
};

// Cache invalidation utilities (for CF API usage)
export const CacheInvalidation = {
  // Invalidate by domain name
  forDomain: (name: string) => [`domain:${name}`],

  // Invalidate by type
  forType: (type: 'migrated' | 'metadata' | 'migration' | 'hierarchy') => [type],

  // Invalidate all metadata
  allMetadata: () => ['metadata'],

  // Invalidate all migration data
  allMigration: () => ['migration'],
};