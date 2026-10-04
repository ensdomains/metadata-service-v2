// Tiered image cache: L1 KV → L2 R2 → L3 Origin with stale-while-revalidate
import { MIGRATION_STATUS, type SvgCacheEntry, type ImageCacheParams, type NetworkName } from '../types';
import { canonicalizeName } from '../utils/ens';
import type { StorageManager } from '../utils/storage';
import { toSafeImage } from './media-safety';
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
  // True when the card was rendered without its avatar because the avatar
  // lookup failed (not because the name has none). Such a card is not written
  // to KV/R2, and routes must not cache it for long either.
  avatarFailed: boolean;
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
// Bump when cards rendered by older code must never be served again. v3:
// pre-fix v2 KV entries carried backfill-time createdAt / full TTL and could
// bypass R2 deadline enforcement (W8-CACHE-004).
const CARD_CACHE_VERSION = 'v3';

export { CARD_CACHE_VERSION };

function buildCacheKey(name: string, network: NetworkName, params: ImageCacheParams): string {
  // Canonical (case-insensitive) name — keep it first so the per-name invalidation
  // prefix (`svg:${name}:`) still matches across both networks.
  return `svg:${canonicalizeName(name)}:${network}:${params.migrationStatus}:${params.width}:${params.height}:${CARD_CACHE_VERSION}`;
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
          return { svg: entry.svg, contentType: 'image/svg+xml', cacheStatus: 'hit', ttlConfig, avatarFailed: false };
        }

        // Stale — return immediately, revalidate in background
        console.log(`[image-cache] L1 STALE ${name} (${Date.now() - start}ms, age ${Math.round(ageSeconds)}s > softTtl ${entry.softTtl}s) → revalidating`);
        executionCtx.waitUntil(
          this.revalidate(name, options, cacheKey, params, ttlConfig).catch((err) =>
            console.error(`[image-cache] background revalidate failed for ${name}:`, err),
          ),
        );
        return { svg: entry.svg, contentType: 'image/svg+xml', cacheStatus: 'stale', ttlConfig, avatarFailed: false };
      }
    } catch (err) {
      console.error(`[image-cache] KV read error for ${cacheKey}:`, err);
    }

    // --- L2: R2 lookup ---
    try {
      const r2Result = await this.storage.getSvgByKey(cacheKey, ttlConfig.r2MaxAge);
      if (r2Result) {
        console.log(`[image-cache] L2 HIT ${name} (${Date.now() - start}ms) → backfilling L1`);
        // Backfill L1 in background, capping KV lifetime to remaining R2 TTL
        executionCtx.waitUntil(
          this.writeKv(cacheKey, r2Result.svg, '', params.migrationStatus, ttlConfig, r2Result.uploadedAtMs).catch((err) =>
            console.error(`[image-cache] KV backfill failed for ${cacheKey}:`, err),
          ),
        );
        return { svg: r2Result.svg, contentType: 'image/svg+xml', cacheStatus: 'stale', ttlConfig, avatarFailed: false };
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

    return { svg, contentType: 'image/svg+xml', cacheStatus: 'miss', ttlConfig, avatarFailed };
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
        // Re-classify the cached bytes instead of trusting the stored type:
        // objects written before the image allowlist carry whatever type the
        // remote server claimed. A rejected object falls through to a fresh
        // resolve below, which overwrites it.
        const safe = r2Avatar ? toSafeImage(new Uint8Array(r2Avatar.data)) : null;
        if (r2Avatar && safe) {
          avatarBase64 = safe.buffer.toString('base64');
          avatarMimeType = safe.mimeType;
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
        // UpstreamError (RPC, CCIP gateway or media host failure, timeout) →
        // avatar might exist but we couldn't get it
        avatarFailed = true;
        console.warn(`[image-cache] avatar RPC failed for ${name}:`, err);
      }
    }

    // Generate SVG. The avatar was looked up above, so the image service must
    // not look it up again (a second lookup would double the wait on an outage).
    const genOptions: ImageGenerationOptions = {
      ...options,
      avatarBase64,
      avatarMimeType,
      skipAvatarLookup: true,
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

  // Write SVG to KV.
  // When uploadedAtMs is provided (R2 backfill), the KV entry uses an
  // absolute `expiration` deadline at uploadedAtMs + r2MaxAge, immune to
  // clock drift between the R2 read and this write.  createdAt is set to
  // the authoritative upload time.  softTtl is capped to the remaining
  // lifetime.  Backfill is skipped when remaining < 60 s (Cloudflare KV
  // minimum).  Fresh L3 origin writes omit uploadedAtMs and use relative
  // expirationTtl as before.
  private async writeKv(
    cacheKey: string,
    svg: string,
    avatarHash: string,
    migrationStatus: string,
    ttlConfig: TtlConfig,
    uploadedAtMs?: number,
  ): Promise<void> {
    if (uploadedAtMs !== undefined) {
      // R2 backfill: compute remaining lifetime from the authoritative
      // upload timestamp right now, not a stale pre-await sample.
      const ageSeconds = (Date.now() - uploadedAtMs) / 1000;
      const remaining = Math.max(0, ttlConfig.r2MaxAge - ageSeconds);
      if (remaining < 60) return;

      const entry: SvgCacheEntry = {
        svg,
        createdAt: uploadedAtMs,
        softTtl: Math.max(1, Math.floor(Math.min(ttlConfig.softTtl, remaining))),
        avatarHash,
        migrationStatus,
      };
      // Absolute expiration — immune to body-latency clock drift.
      await this.svgCacheKv.put(cacheKey, JSON.stringify(entry), {
        expiration: Math.floor(uploadedAtMs / 1000) + ttlConfig.r2MaxAge,
      });
      return;
    }

    // Fresh L3 origin: use relative TTLs as before.
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
