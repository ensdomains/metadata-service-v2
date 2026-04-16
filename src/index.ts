import "./shims";
import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { cache } from "hono/cache";
import { timeout } from "hono/timeout";
import {
  validateNetwork,
  validateEnsNameParam,
  rateLimiter,
  requestLogger,
} from "./middleware/validation";
import { MetadataService, DomainExpiredError } from "./services/metadata";
import { WebhookService } from "./services/webhook";
import { CacheService } from "./services/cache";
import { ImageGenerationService } from "./services/image";
import { AvatarService } from "./services/avatar";
import { ImageCacheService } from "./services/image-cache";
import { MetadataCacheService } from "./services/metadata-cache";
import { StorageManager } from "./utils/storage";
import { RasterizeService } from "./services/rasterize";
const rasterizeService = new RasterizeService();
import { CachePresets } from "./utils/cache-headers";
import type {
  HealthResponse,
  ErrorResponse,
} from "./types/api";
import type { ImageGenerationOptions } from "./services/image";

export interface Env {
  // KV Namespaces
  METADATA_CACHE: KVNamespace;
  SVG_CACHE: KVNamespace;

  // R2 Bucket
  ASSET_BUCKET: R2Bucket;

  // D1 Database
  DB: D1Database;


  // Environment Variables
  ENSNODE_MAINNET_URL: string;
  ENSNODE_SEPOLIA_URL: string;
  MAINNET_RPC_URL: string;
  SEPOLIA_RPC_URL: string;
  MAINNET_FALLBACK_RPC_1?: string;
  MAINNET_FALLBACK_RPC_2?: string;
  MAINNET_FALLBACK_RPC_3?: string;
  SEPOLIA_FALLBACK_RPC_1?: string;
  SEPOLIA_FALLBACK_RPC_2?: string;
  WEBHOOK_SECRET?: string;
  LOG_LEVEL: string;
}

const app = new Hono<{ Bindings: Env }>();

// CF Cache API helper — Workers exposes caches.default but TS lib types don't include it
function getCfCache(): Cache | null {
  try {
    return typeof caches !== 'undefined' ? (caches as any).default : null;
  } catch { return null; }
}

// --- Singleton service cache (module-level, persists across requests in same isolate) ---

type ImageServices = {
  avatarService: AvatarService;
  imageService: ImageGenerationService;
  imageCacheService: ImageCacheService;
};

type FullServices = {
  metadataService: MetadataService;
  webhookService: WebhookService;
  cacheService: CacheService;
  metadataCacheService: MetadataCacheService;
};

const _imageServices = new Map<string, ImageServices>();
const _fullServices = new Map<string, FullServices>();

function getRpcUrl(env: Env, network: string): string {
  return network === 'sepolia' ? env.SEPOLIA_RPC_URL : env.MAINNET_RPC_URL;
}

function getEnsnodeUrl(env: Env, network: string): string {
  return network === 'sepolia' ? env.ENSNODE_SEPOLIA_URL : env.ENSNODE_MAINNET_URL;
}

function getImageServices(env: Env, network: string): ImageServices {
  const cached = _imageServices.get(network);
  if (cached) return cached;

  const avatarService = new AvatarService(getRpcUrl(env, network));
  const imageService = new ImageGenerationService(avatarService);
  const storageManager = new StorageManager(env.ASSET_BUCKET);
  const imageCacheService = new ImageCacheService(env.SVG_CACHE, storageManager, imageService, avatarService);
  const services = { avatarService, imageService, imageCacheService };
  _imageServices.set(network, services);
  return services;
}

function getServices(env: Env, network: string): FullServices {
  const cached = _fullServices.get(network);
  if (cached) return cached;

  const cacheService = new CacheService(env.METADATA_CACHE);

  const metadataService = new MetadataService(
    {
      ensnodeEndpoint: getEnsnodeUrl(env, network),
      network,
      fallbackToBlockchain: true,
      internalCacheEnabled: true,
      d1Enabled: true,
    },
    env.METADATA_CACHE,
    {
      MAINNET_RPC_URL: env.MAINNET_RPC_URL,
      SEPOLIA_RPC_URL: env.SEPOLIA_RPC_URL,
      MAINNET_FALLBACK_RPC_1: env.MAINNET_FALLBACK_RPC_1,
      MAINNET_FALLBACK_RPC_2: env.MAINNET_FALLBACK_RPC_2,
      MAINNET_FALLBACK_RPC_3: env.MAINNET_FALLBACK_RPC_3,
      SEPOLIA_FALLBACK_RPC_1: env.SEPOLIA_FALLBACK_RPC_1,
      SEPOLIA_FALLBACK_RPC_2: env.SEPOLIA_FALLBACK_RPC_2,
    },
    env.DB,
  );

  const storageManager = new StorageManager(env.ASSET_BUCKET);

  const webhookService = new WebhookService(
    cacheService,
    {
      requireAuth: !!env.WEBHOOK_SECRET,
      secret: env.WEBHOOK_SECRET,
    },
    env.SVG_CACHE,
    storageManager,
    env.METADATA_CACHE,
  );

  const metadataCacheService = new MetadataCacheService(env.METADATA_CACHE);

  const services = { metadataService, webhookService, cacheService, metadataCacheService };
  _fullServices.set(network, services);
  return services;
}

// Middleware
app.use(trimTrailingSlash());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use("*", requestLogger);
app.use("*", logger());
app.use("*", prettyJSON());
// 30s timeout for all routes except /health (health has its own graceful handling)
app.use("*", async (c, next) => {
  if (c.req.path === '/health' || c.req.path === '/') return next();
  return timeout(30000)(c, next);
});
app.use("*", rateLimiter);

// Cache middleware for GET requests
app.use("/*/metadata/*", cache({
  cacheName: "metadata-cache",
  cacheControl: "max-age=300", // 5 minutes
}));

app.use("/migration-status/*", cache({
  cacheName: "migration-cache",
  cacheControl: "max-age=60", // 1 minute
}));

app.use("/registry-hierarchy/*", cache({
  cacheName: "hierarchy-cache",
  cacheControl: "max-age=300", // 5 minutes
}));

// Health check
app.get("/", (c) => {
  return c.json({
    service: "ENS Metadata V2",
    version: "2.0.0",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Avatar endpoint: /{network}/avatar/{name}
app.get(
  "/:network/avatar/:name",
  validateNetwork,
  validateEnsNameParam,
  async (c) => {
    const { network, name } = c.req.param();
    const { avatarService } = getImageServices(c.env, network);

    try {
      const avatar = await avatarService.getAvatarImage(name);
      if (!avatar) {
        return c.json({ message: `No avatar set for ${name}` } as any, 404);
      }

      return new Response(new Uint8Array(avatar.buffer), {
        status: 200,
        headers: {
          'Content-Type': avatar.mimeType,
          'Content-Length': avatar.buffer.length.toString(),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      console.error("Avatar resolution error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve avatar",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 500);
    }
  }
);

// Shared metadata handler — used by both v1 (tokenId) and v2 (name) routes
async function handleMetadata(
  c: any,
  network: string,
  registryType: string,
  name: string,
) {
  const { metadataService, metadataCacheService } = getServices(c.env, network);

  // Check expiry before anything else (including cache)
  await metadataService.checkExpiry(name);

  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const { metadata, cacheStatus, ttlConfig } = await metadataCacheService.get(
    network,
    registryType,
    name,
    c.executionCtx,
    () => metadataService.getMetadata(
      network as 'mainnet' | 'sepolia',
      registryType as 'registry' | 'namewrapper',
      name,
      baseUrl,
    ),
  );

  c.header('X-Cache-Status', cacheStatus);
  c.header('Cache-Control', `public, max-age=${ttlConfig.softTtl}, stale-while-revalidate=${ttlConfig.hardTtl - ttlConfig.softTtl}`);
  return c.json(metadata);
}

// Shared image handler — used by both v1 (tokenId) and v2 (name) routes
async function handleImage(c: any, network: string, name: string) {
  // L0: Cloudflare edge cache — microsecond hit, skips all processing
  const cfCache = getCfCache();
  if (cfCache) {
    const cached = await cfCache.match(c.req.url);
    if (cached) return new Response(cached.body, cached);
  }

  const { imageService, imageCacheService } = getImageServices(c.env, network);

  const status = c.req.query('status');
  const width = c.req.query('w');
  const height = c.req.query('h');

  const options: ImageGenerationOptions = { name };
  if (status) options.migrationStatus = status as 'migrated' | 'native' | 'unmigrated';
  if (width && height) {
    options.size = { width: parseInt(width, 10), height: parseInt(height, 10) };
  }

  const validation = imageService.validateOptions(options);
  if (!validation.valid) {
    const errorResponse: ErrorResponse = {
      error: `Invalid image parameters: ${validation.errors.join(', ')}`,
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 400);
  }

  if (!status) options.migrationStatus = 'unmigrated';

  const result = await imageCacheService.getImage(name, options, c.executionCtx);
  const { ttlConfig, cacheStatus } = result;

  const response = new Response(result.svg, {
    status: 200,
    headers: {
      'Content-Type': result.contentType,
      'X-Cache-Status': cacheStatus,
      'Cache-Control': `public, max-age=${ttlConfig.softTtl}, stale-while-revalidate=${ttlConfig.hardTtl - ttlConfig.softTtl}`,
    },
  });

  // Store in CF edge cache — next identical request returns instantly
  if (cfCache) {
    c.executionCtx.waitUntil(cfCache.put(c.req.url, response.clone()));
  }

  return response;
}

// Helper to check if a param is a contract address (0x-prefixed, 42 chars)
function isContractAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// Unified metadata endpoint: handles both v1 (contractAddress/tokenId) and v2 (registryType/name)
app.get(
  "/:network/:param2/:param3",
  validateNetwork,
  async (c) => {
    const { network, param2, param3 } = c.req.param();

    try {
      // v1 route: param2 is a contract address (0x-prefixed hex)
      if (isContractAddress(param2)) {
        const { metadataService } = getServices(c.env, network);
        const { name, registryType } = await metadataService.resolveTokenId(
          network as 'mainnet' | 'sepolia',
          param2,
          param3,
        );
        return await handleMetadata(c, network, registryType, name);
      }

      // v2 route: param2 is registryType
      if (param2 === 'registry' || param2 === 'namewrapper') {
        if (!param3 || param3.trim().length === 0) {
          return c.json({ error: "Identifier cannot be empty", timestamp: new Date().toISOString() }, 400);
        }
        return await handleMetadata(c, network, param2, param3);
      }

      return c.json({ error: "Invalid route. Second parameter must be 'registry', 'namewrapper', or a contract address", timestamp: new Date().toISOString() }, 400);
    } catch (error) {
      if (error instanceof DomainExpiredError) {
        return c.json({ message: error.message }, 410 as any);
      }

      console.error("Metadata resolution error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve metadata",
        timestamp: new Date().toISOString(),
      };

      const status = error instanceof Error && (error.message.includes('No domain found') || error.message.includes('Unknown contract')) ? 404 : 500;

      if (status === 500) {
        const errorCacheHeaders = CachePresets.error();
        Object.entries(errorCacheHeaders).forEach(([key, value]) => {
          c.header(key, value);
        });
      }

      return c.json(errorResponse, status as any);
    }
  }
);

// Migration status endpoint
app.get(
  "/migration-status/:name",
  validateEnsNameParam,
  async (c) => {
    const { name } = c.req.param();
    const network = c.req.query('network') || 'mainnet';
    const { metadataService } = getServices(c.env, network);

    try {
      await metadataService.checkExpiry(name);

      const migrationStatus = await metadataService.getMigrationStatus(name);

      const cacheHeaders = CachePresets.migrationStatus(name);
      Object.entries(cacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(migrationStatus);
    } catch (error) {
      if (error instanceof DomainExpiredError) {
        return c.json({ message: error.message }, 410 as any);
      }

      console.error("Migration status error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to check migration status",
        timestamp: new Date().toISOString(),
      };

      const errorCacheHeaders = CachePresets.error();
      Object.entries(errorCacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(errorResponse, 500);
    }
  }
);

// Registry hierarchy endpoint
app.get(
  "/registry-hierarchy/:name",
  validateEnsNameParam,
  async (c) => {
    const { name } = c.req.param();
    const network = c.req.query('network') || 'mainnet';
    const { metadataService } = getServices(c.env, network);

    try {
      await metadataService.checkExpiry(name);

      const hierarchy = await metadataService.getRegistryHierarchy(name);

      const cacheHeaders = CachePresets.hierarchy(name);
      Object.entries(cacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(hierarchy);
    } catch (error) {
      if (error instanceof DomainExpiredError) {
        return c.json({ message: error.message }, 410 as any);
      }

      console.error("Registry hierarchy error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve registry hierarchy",
        timestamp: new Date().toISOString(),
      };

      const errorCacheHeaders = CachePresets.error();
      Object.entries(errorCacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(errorResponse, 500);
    }
  }
);

// Batch metadata endpoint
app.post("/batch-metadata", async (c) => {
  try {
    const body = await c.req.json();

    if (!body.names || !Array.isArray(body.names)) {
      const errorResponse: ErrorResponse = {
        error: "Request body must contain 'names' array",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 400);
    }

    if (body.names.length === 0) {
      const errorResponse: ErrorResponse = {
        error: "Names array cannot be empty",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 400);
    }

    if (body.names.length > 100) {
      const errorResponse: ErrorResponse = {
        error: "Cannot process more than 100 names at once",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 400);
    }

    const network = body.network || 'mainnet';
    const registryType = body.registryType || 'registry';
    const { metadataService, metadataCacheService } = getServices(c.env, network);
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Resolve each name through the metadata cache (KV + SWR)
    const results = await Promise.allSettled(
      body.names.map(async (name: string) => {
        try {
          const { metadata } = await metadataCacheService.get(
            network,
            registryType,
            name,
            c.executionCtx,
            () => metadataService.getMetadata(
              network as 'mainnet' | 'sepolia',
              registryType as 'registry' | 'namewrapper',
              name,
              baseUrl,
            ),
          );
          return { name, metadata };
        } catch (err) {
          if (err instanceof DomainExpiredError) {
            return { name, error: err.message };
          }
          return { name, error: `Failed to resolve ${name}` };
        }
      }),
    );

    const batchResponse = {
      results: results.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { name: body.names[i], error: 'Processing failed' },
      ),
      total: body.names.length,
      successful: results.filter(r => r.status === 'fulfilled' && !('error' in r.value)).length,
      failed: results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && 'error' in r.value)).length,
    };

    return c.json(batchResponse);
  } catch (error) {
    console.error("Batch metadata error:", error);
    const errorResponse: ErrorResponse = {
      error: error instanceof Error ? error.message : "Failed to process batch metadata request",
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

// Health check with detailed status
app.get("/health", async (c) => {
  const { metadataService } = getServices(c.env, 'mainnet');

  try {
    const serviceHealth = await Promise.race([
      metadataService.healthCheck(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 15000)),
    ]);

    const health: HealthResponse = {
      service: "ENS Metadata V2",
      version: "2.0.0",
      status: serviceHealth.ensnode === 'ok' &&
              serviceHealth.blockchain.mainnet === 'ok' &&
              serviceHealth.blockchain.sepolia === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: {
        indexer: serviceHealth.ensnode as 'ok' | 'degraded' | 'error' | 'unknown',
        mainnet: serviceHealth.blockchain.mainnet as 'ok' | 'degraded' | 'error' | 'unknown',
        sepolia: serviceHealth.blockchain.sepolia as 'ok' | 'degraded' | 'error' | 'unknown',
      },
      latency: {
        indexer: serviceHealth.ensnodeLatency,
      },
    };

    // Set CF cache headers for health check
    const cacheHeaders = CachePresets.health();
    Object.entries(cacheHeaders).forEach(([key, value]) => {
      c.header(key, value);
    });

    return c.json(health);
  } catch (error) {
    // Timeout or other failures should still return a degraded health status,
    // not a generic 500 — the whole point of /health is to report what's up/down
    console.error("Health check error:", error);

    const isTimeout = error instanceof Error && (error.message.includes('Timeout') || error.message.includes('Gateway'));

    const health: HealthResponse = {
      service: "ENS Metadata V2",
      version: "2.0.0",
      status: "degraded",
      timestamp: new Date().toISOString(),
      dependencies: {
        indexer: isTimeout ? 'error' : 'unknown',
        mainnet: 'unknown',
        sepolia: 'unknown',
      },
    };

    const errorCacheHeaders = CachePresets.error();
    Object.entries(errorCacheHeaders).forEach(([key, value]) => {
      c.header(key, value);
    });

    return c.json(health, 503);
  }
});


// Unified image endpoint: handles both v1 (contractAddress/tokenId) and v2 (registryType/name)
app.get(
  "/:network/:param2/:param3/image",
  validateNetwork,
  async (c) => {
    const { network, param2, param3 } = c.req.param();

    try {
      let name: string;

      if (isContractAddress(param2)) {
        // v1: resolve tokenId to name
        const { metadataService } = getServices(c.env, network);
        const resolved = await metadataService.resolveTokenId(
          network as 'mainnet' | 'sepolia',
          param2,
          param3,
        );
        name = resolved.name;
      } else if (param2 === 'registry' || param2 === 'namewrapper') {
        // v2: param3 is the ENS name
        name = param3;
      } else {
        return c.json({ error: "Invalid route", timestamp: new Date().toISOString() }, 400);
      }

      // Check expiry before generating image
      const { metadataService } = getServices(c.env, network);
      await metadataService.checkExpiry(name);

      return await handleImage(c, network, name);
    } catch (error) {
      if (error instanceof DomainExpiredError) {
        return c.json({ message: error.message }, 410 as any);
      }

      console.error("Image generation error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to generate image",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, error instanceof Error && error.message.includes('No domain found') ? 404 : 500);
    }
  }
);

// Unified rasterize endpoint: SVG → PNG via rasterize-wasm
app.get(
  "/:network/:param2/:param3/rasterize",
  validateNetwork,
  async (c) => {
    const { network, param2, param3 } = c.req.param();

    try {
      let name: string;

      if (isContractAddress(param2)) {
        const { metadataService } = getServices(c.env, network);
        const resolved = await metadataService.resolveTokenId(
          network as 'mainnet' | 'sepolia',
          param2,
          param3,
        );
        name = resolved.name;
      } else if (param2 === 'registry' || param2 === 'namewrapper') {
        name = param3;
      } else {
        return c.json({ error: "Invalid route", timestamp: new Date().toISOString() }, 400);
      }

      // L0: Cloudflare edge cache for rasterized PNGs
      const cfCache = getCfCache();
      if (cfCache) {
        const cached = await cfCache.match(c.req.url);
        if (cached) return new Response(cached.body, cached);
      }

      // Check expiry
      const { metadataService } = getServices(c.env, network);
      await metadataService.checkExpiry(name);

      // Get the SVG (reuses image pipeline)
      const { imageService, imageCacheService } = getImageServices(c.env, network);

      const status = c.req.query('status');
      const outputWidth = c.req.query('w') ? parseInt(c.req.query('w')!, 10) : null;
      const outputHeight = c.req.query('h') ? parseInt(c.req.query('h')!, 10) : null;

      const options: ImageGenerationOptions = { name };
      if (status) options.migrationStatus = status as 'migrated' | 'native' | 'unmigrated';

      // Non-square: pass actual dimensions so layout composer handles aspect ratio
      // Square: generate at default size, rewrite width/height (viewBox scaling handles it)
      const hasCustomSize = outputWidth && outputHeight && outputWidth >= 100 && outputWidth <= 2000 && outputHeight >= 100 && outputHeight <= 2000;
      const isNonSquare = hasCustomSize && outputWidth !== outputHeight;
      if (isNonSquare) {
        options.size = { width: outputWidth!, height: outputHeight! };
      }

      const validation = imageService.validateOptions(options);
      if (!validation.valid) {
        return c.json({ error: `Invalid image parameters: ${validation.errors.join(', ')}`, timestamp: new Date().toISOString() }, 400);
      }
      if (!status) options.migrationStatus = 'unmigrated';

      const result = await imageCacheService.getImage(name, options, c.executionCtx);

      // Square custom size: rewrite SVG width/height (viewBox stays fixed for auto-scaling)
      let svgForRasterize = result.svg;
      if (hasCustomSize && !isNonSquare) {
        svgForRasterize = svgForRasterize.replace(
          /<svg([^>]*)\bwidth="(\d+)"([^>]*)\bheight="(\d+)"/,
          `<svg$1width="${outputWidth}"$3height="${outputHeight}"`
        );
      }

      // Rasterize SVG to PNG
      const png = await rasterizeService.rasterize(svgForRasterize, c.env.ASSET_BUCKET);

      const pngResponse = new Response(png.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': png.byteLength.toString(),
          'X-Cache-Status': result.cacheStatus,
          'Cache-Control': `public, max-age=${result.ttlConfig.softTtl}, stale-while-revalidate=${result.ttlConfig.hardTtl - result.ttlConfig.softTtl}`,
        },
      });

      // Store rasterized PNG in CF edge cache
      if (cfCache) {
        c.executionCtx.waitUntil(cfCache.put(c.req.url, pngResponse.clone()));
      }

      return pngResponse;
    } catch (error) {
      if (error instanceof DomainExpiredError) {
        return c.json({ message: error.message }, 410 as any);
      }

      console.error("Rasterize error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to rasterize image",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, error instanceof Error && error.message.includes('No domain found') ? 404 : 500);
    }
  }
);

// Webhook endpoint for cache invalidation + proactive warming
app.post("/webhook/ensnode", async (c) => {
  const bodyClone = c.req.raw.clone();
  const { webhookService } = getServices(c.env, 'mainnet');

  try {
    const response = await webhookService.handleWebhook(c);

    // Background: purge CF edge cache + proactively warm image cache
    c.executionCtx.waitUntil((async () => {
      try {
        const payload = await bodyClone.json() as { domain?: { name?: string }; network?: string };
        const name = payload?.domain?.name;
        const network = payload?.network || 'mainnet';
        if (!name) return;

        // Purge CF edge cache entries for this domain (common URL patterns)
        const cfCache = getCfCache();
        if (cfCache) {
          const origin = new URL(c.req.url).origin;
          await Promise.all([
            cfCache.delete(new Request(`${origin}/${network}/registry/${name}/image`)),
            cfCache.delete(new Request(`${origin}/${network}/registry/${name}/rasterize`)),
          ]);
        }

        // Proactive warming: regenerate default image so next request hits warm cache
        const { imageCacheService } = getImageServices(c.env, network);
        await imageCacheService.getImage(name, { name, migrationStatus: 'unmigrated' }, c.executionCtx);
        console.log(`[webhook] proactively warmed image cache for ${name}`);
      } catch (err) {
        console.warn('[webhook] cache warming failed:', err);
      }
    })());

    return response;
  } catch (error) {
    console.error("Webhook handling error:", error);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});


export default app;
