// Tiered image cache: L1 KV → L2 R2 → L3 Origin with stale-while-revalidate
import { MIGRATION_STATUS, type SvgCacheEntry, type ImageCacheParams, type MigrationStatus, type NetworkName } from '../types';
import { canonicalizeName } from '../utils/ens';
import type { StorageManager } from '../utils/storage';
import type { ImageGenerationService, ImageGenerationOptions } from './image';
import type { AvatarService } from './avatar';

// TTL configuration per migration status
interface TtlConfig {
  softTtl: number;   // seconds — serve but trigger background revalidate
  hardTtl: number;   // seconds — KV expiration
  r2MaxAge: number;   // seconds — R2 cache-control max-age
}

export type CacheStatus = 'hit' | 'stale' | 'miss';

export interface ImageCacheResult {
  svg: string;
  contentType: string;
  cacheStatus: CacheStatus;
  ttlConfig: TtlConfig;
}

// Convert ArrayBuffer to base64 string
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Compute SHA-256 hex digest of an ArrayBuffer
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Build a deterministic cache key from name + network + image params.
// `name` stays first so the per-name invalidation prefix (`svg:${name}:`) still
// matches across both networks. `network` prevents mainnet/sepolia collisions —
// the same name renders differently per network (avatar, migration status).
function buildCacheKey(name: string, network: NetworkName, params: ImageCacheParams): string {
  // Canonical (case-insensitive) name — keep it first so the per-name invalidation
  // prefix (`svg:${name}:`) still matches across both networks.
  return `svg:${canonicalizeName(name)}:${network}:${params.migrationStatus}:${params.width}:${params.height}`;
}

export class ImageCacheService {
  constructor(
    private svgCacheKv: KVNamespace,
    private storage: StorageManager,
    private imageService: ImageGenerationService,
    private avatarService: AvatarService,
    private network: NetworkName,
    private bucket?: R2Bucket,
  ) {}

  // Get TTL config based on migration status
  getTtlConfig(migrationStatus: string): TtlConfig {
    switch (migrationStatus) {
      case MIGRATION_STATUS.NATIVE:
      case MIGRATION_STATUS.MIGRATED:
        return { softTtl: 21600, hardTtl: 86400, r2MaxAge: 86400 };      // 6h / 24h / 24h
      case MIGRATION_STATUS.UNMIGRATED:
        return { softTtl: 300, hardTtl: 1800, r2MaxAge: 3600 };           // 5m / 30m / 1h
      default:
        return { softTtl: 3600, hardTtl: 21600, r2MaxAge: 21600 };        // 1h / 6h / 6h
    }
  }

  // Main entry point: tiered cache lookup with stale-while-revalidate
  async getImage(
    name: string,
    options: ImageGenerationOptions,
    executionCtx: ExecutionContext,
  ): Promise<ImageCacheResult> {
    const params: ImageCacheParams = {
      migrationStatus: options.migrationStatus || MIGRATION_STATUS.UNMIGRATED,
      width: options.size?.width || 518,
      height: options.size?.height || 518,
    };

    const cacheKey = buildCacheKey(name, this.network, params);
    const ttlConfig = this.getTtlConfig(params.migrationStatus);

    const start = Date.now();

    // --- L1: KV lookup ---
    try {
      const kvRaw = await this.svgCacheKv.get(cacheKey);
      if (kvRaw) {
        const entry: SvgCacheEntry = JSON.parse(kvRaw);
        const ageSeconds = (Date.now() - entry.createdAt) / 1000;

        if (ageSeconds < entry.softTtl) {
          console.log(`[image-cache] L1 HIT ${name} (${Date.now() - start}ms, age ${Math.round(ageSeconds)}s)`);
          return { svg: entry.svg, contentType: 'image/svg+xml', cacheStatus: 'hit', ttlConfig };
        }

        // Stale — return immediately, revalidate in background
        console.log(`[image-cache] L1 STALE ${name} (${Date.now() - start}ms, age ${Math.round(ageSeconds)}s > softTtl ${entry.softTtl}s) → revalidating`);
        executionCtx.waitUntil(
          this.revalidate(name, options, cacheKey, params, ttlConfig).catch((err) =>
            console.error(`[image-cache] background revalidate failed for ${name}:`, err),
          ),
        );
        return { svg: entry.svg, contentType: 'image/svg+xml', cacheStatus: 'stale', ttlConfig };
      }
    } catch (err) {
      console.error(`[image-cache] KV read error for ${cacheKey}:`, err);
    }

    // --- L2: R2 lookup ---
    try {
      const r2Svg = await this.storage.getSvgByKey(cacheKey);
      if (r2Svg) {
        console.log(`[image-cache] L2 HIT ${name} (${Date.now() - start}ms) → backfilling L1`);
        // Backfill L1 in background
        executionCtx.waitUntil(
          this.writeKv(cacheKey, r2Svg, '', params.migrationStatus, ttlConfig).catch((err) =>
            console.error(`[image-cache] KV backfill failed for ${cacheKey}:`, err),
          ),
        );
        return { svg: r2Svg, contentType: 'image/svg+xml', cacheStatus: 'stale', ttlConfig };
      }
    } catch (err) {
      console.error(`[image-cache] R2 read error for ${cacheKey}:`, err);
    }

    // --- L3: Origin (generate from scratch) ---
    const { svg, avatarHash, avatarFailed } = await this.generateFromOrigin(name, options);
    console.log(`[image-cache] L3 MISS ${name} (${Date.now() - start}ms)${avatarFailed ? ' [avatar failed — skipping cache]' : ' → writing back to L1+L2'}`);

    // Only cache if avatar didn't fail — avoid persisting SVGs without background
    if (!avatarFailed) {
      executionCtx.waitUntil(
        this.writeBackAll(cacheKey, svg, avatarHash, params.migrationStatus, ttlConfig).catch(
          (err) => console.error(`[image-cache] write-back failed for ${cacheKey}:`, err),
        ),
      );
    }

    return { svg, contentType: 'image/svg+xml', cacheStatus: 'miss', ttlConfig };
  }

  // Invalidate all cache entries for a domain name
  async invalidate(name: string): Promise<void> {
    const kvPrefix = `svg:${canonicalizeName(name)}:`;
    const errors: Error[] = [];

    // KV: list and delete all keys with this prefix
    try {
      const list = await this.svgCacheKv.list({ prefix: kvPrefix });
      if (list.keys.length > 0) {
        await Promise.all(list.keys.map((k) => this.svgCacheKv.delete(k.name)));
      }
    } catch (err) {
      errors.push(err as Error);
      console.error(`[image-cache] KV invalidation failed for ${name}:`, err);
    }

    // R2: delete avatar + SVG prefix
    try {
      await Promise.all([
        // avatars are keyed `avatars/${name}:${network}` — prefix-delete both networks
        this.storage.deleteByPrefix(`avatars/${canonicalizeName(name)}:`),
        this.storage.deleteByPrefix(`svg/svg:${canonicalizeName(name)}:`),
      ]);
    } catch (err) {
      errors.push(err as Error);
      console.error(`[image-cache] R2 invalidation failed for ${name}:`, err);
    }

    if (errors.length > 0) {
      console.warn(`[image-cache] invalidation completed with ${errors.length} error(s) for ${name}`);
    }
  }

  // --- Private helpers ---

  // Full origin generation: avatar resolve + SVG generate
  private async generateFromOrigin(
    name: string,
    options: ImageGenerationOptions,
  ): Promise<{ svg: string; avatarHash: string; avatarFailed: boolean }> {
    let avatarBase64: string | undefined = options.avatarBase64;
    let avatarMimeType: string | undefined = options.avatarMimeType;
    let avatarHash = '';
    let avatarFailed = false;

    // Network-qualified avatar cache key: the same name resolves to different
    // avatars per network, so mainnet/sepolia must not share an R2 avatar entry.
    const avatarKey = `${canonicalizeName(name)}:${this.network}`;

    // Try R2 avatar cache first
    if (!avatarBase64) {
      try {
        const r2Avatar = await this.storage.getAvatar(avatarKey);
        if (r2Avatar) {
          avatarBase64 = arrayBufferToBase64(r2Avatar.data);
          avatarMimeType = r2Avatar.contentType;
          avatarHash = await sha256Hex(r2Avatar.data);
        }
      } catch (err) {
        console.warn(`[image-cache] R2 avatar read failed for ${name}:`, err);
      }
    }

    // If still no avatar, resolve via RPC (the expensive path)
    if (!avatarBase64) {
      try {
        const avatar = await this.avatarService.getAvatarImage(name);
        if (avatar) {
          avatarBase64 = avatar.buffer.toString('base64');
          avatarMimeType = avatar.mimeType;
          const ab = avatar.buffer.buffer.slice(
            avatar.buffer.byteOffset,
            avatar.buffer.byteOffset + avatar.buffer.byteLength,
          ) as ArrayBuffer;
          avatarHash = await sha256Hex(ab);

          // Cache avatar in R2 for next time (network-qualified key)
          try {
            await this.storage.setAvatar(avatarKey, ab, avatar.mimeType);
          } catch (err) {
            console.warn(`[image-cache] R2 avatar write failed for ${name}:`, err);
          }
        }
        // avatar is null → name genuinely has no avatar (avatarFailed stays false)
      } catch (err) {
        // RPC/fetch error → avatar might exist but we couldn't get it
        avatarFailed = true;
        console.warn(`[image-cache] avatar RPC failed for ${name}:`, err);
      }
    }

    // Generate SVG
    const genOptions: ImageGenerationOptions = {
      ...options,
      avatarBase64,
      avatarMimeType,
    };

    const image = await this.imageService.generateDomainImage(genOptions, this.bucket);
    const svg = typeof image.svg === 'string' ? image.svg : String(image.svg);

    return { svg, avatarHash, avatarFailed };
  }

  // Background revalidation: regenerate and write back
  private async revalidate(
    name: string,
    options: ImageGenerationOptions,
    cacheKey: string,
    params: ImageCacheParams,
    ttlConfig: TtlConfig,
  ): Promise<void> {
    const { svg, avatarHash, avatarFailed } = await this.generateFromOrigin(name, options);
    if (avatarFailed) {
      console.warn(`[image-cache] revalidate skipped for ${name}: avatar fetch failed`);
      return;
    }
    await this.writeBackAll(cacheKey, svg, avatarHash, params.migrationStatus, ttlConfig);
  }

  // Write SVG to KV
  private async writeKv(
    cacheKey: string,
    svg: string,
    avatarHash: string,
    migrationStatus: string,
    ttlConfig: TtlConfig,
  ): Promise<void> {
    const entry: SvgCacheEntry = {
      svg,
      createdAt: Date.now(),
      softTtl: ttlConfig.softTtl,
      avatarHash,
      migrationStatus,
    };
    await this.svgCacheKv.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: ttlConfig.hardTtl,
    });
  }

  // Write back to all cache tiers
  private async writeBackAll(
    cacheKey: string,
    svg: string,
    avatarHash: string,
    migrationStatus: string,
    ttlConfig: TtlConfig,
  ): Promise<void> {
    await Promise.all([
      this.writeKv(cacheKey, svg, avatarHash, migrationStatus, ttlConfig),
      this.storage.setSvgByKey(cacheKey, svg, ttlConfig.r2MaxAge),
    ]);
  }
}
