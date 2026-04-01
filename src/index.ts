import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { cache } from "hono/cache";
import { timeout } from "hono/timeout";
import {
  validateNetwork,
  validateRegistryType,
  validateEnsNameParam,
  validateIdentifier,
  rateLimiter,
  requestLogger,
} from "./middleware/validation";
import { MetadataService } from "./services/metadata";
import { WebhookService } from "./services/webhook";
import { CacheService } from "./services/cache";
import { ImageGenerationService } from "./services/image";
import { AvatarService } from "./services/avatar";
import { ImageCacheService } from "./services/image-cache";
import { MetadataCacheService } from "./services/metadata-cache";
import { StorageManager } from "./utils/storage";
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
  ENSNODE_GRAPHQL_URL: string;
  MAINNET_RPC_URL: string;
  SEPOLIA_RPC_URL: string;
  MAINNET_FALLBACK_RPC_1?: string;
  MAINNET_FALLBACK_RPC_2?: string;
  MAINNET_FALLBACK_RPC_3?: string;
  SEPOLIA_FALLBACK_RPC_1?: string;
  SEPOLIA_FALLBACK_RPC_2?: string;
  LOG_LEVEL: string;
}

const app = new Hono<{ Bindings: Env }>();

// Lightweight services (no heavy initialization)
function getImageServices(env: Env) {
  const avatarService = new AvatarService(env.MAINNET_RPC_URL);
  const imageService = new ImageGenerationService(avatarService);
  const storageManager = new StorageManager(env.ASSET_BUCKET);
  const imageCacheService = new ImageCacheService(env.SVG_CACHE, storageManager, imageService, avatarService);
  return { imageService, imageCacheService };
}

// Full service set (includes MetadataService which initializes ensnode)
function getServices(env: Env) {
  const cacheService = new CacheService(env.METADATA_CACHE);

  const metadataService = new MetadataService(
    {
      ensnodeEndpoint: env.ENSNODE_GRAPHQL_URL,
      fallbackToBlockchain: true,
      internalCacheEnabled: true, // Enable internal KV cache for ensnode responses
      d1Enabled: true, // Enable D1 sync
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
    env.DB // Pass D1 database
  );

  const storageManager = new StorageManager(env.ASSET_BUCKET);

  const webhookService = new WebhookService(
    cacheService,
    { requireAuth: false }, // TODO: Configure based on environment
    env.SVG_CACHE,
    storageManager,
    env.METADATA_CACHE,
  );

  const metadataCacheService = new MetadataCacheService(env.METADATA_CACHE);

  return { metadataService, webhookService, cacheService, metadataCacheService };
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
app.use("*", timeout(30000)); // 30 second timeout
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

// Metadata endpoint: /{network}/{registryType}/{identifier}
app.get(
  "/:network/:registryType/:identifier",
  validateNetwork,
  validateRegistryType,
  validateIdentifier,
  async (c) => {
    const { network, registryType, identifier } = c.req.param();
    const { metadataService, metadataCacheService } = getServices(c.env);

    try {
      const { metadata, cacheStatus, ttlConfig } = await metadataCacheService.get(
        network,
        registryType,
        identifier,
        c.executionCtx,
        () => {
          const url = new URL(c.req.url);
          const baseUrl = `${url.protocol}//${url.host}`;
          return metadataService.getMetadata(
            network as 'mainnet' | 'sepolia',
            registryType as 'registry' | 'namewrapper',
            identifier,
            baseUrl,
          );
        },
      );

      // Set cache headers
      c.header('X-Cache-Status', cacheStatus);
      c.header('Cache-Control', `public, max-age=${ttlConfig.softTtl}, stale-while-revalidate=${ttlConfig.hardTtl - ttlConfig.softTtl}`);

      return c.json(metadata);
    } catch (error) {
      console.error("Metadata resolution error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve metadata",
        timestamp: new Date().toISOString(),
      };

      // Set error cache headers
      const errorCacheHeaders = CachePresets.error();
      Object.entries(errorCacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(errorResponse, 500);
    }
  }
);

// Migration status endpoint
app.get(
  "/migration-status/:name",
  validateEnsNameParam,
  async (c) => {
    const { name } = c.req.param();
    const { metadataService } = getServices(c.env);

    try {
      const migrationStatus = await metadataService.getMigrationStatus(name);

      // Set CF cache headers for migration status
      const cacheHeaders = CachePresets.migrationStatus(name);
      Object.entries(cacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(migrationStatus);
    } catch (error) {
      console.error("Migration status error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to check migration status",
        timestamp: new Date().toISOString(),
      };

      // Set error cache headers
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
    const { metadataService } = getServices(c.env);

    try {
      const hierarchy = await metadataService.getRegistryHierarchy(name);
      return c.json(hierarchy);
    } catch (error) {
      console.error("Registry hierarchy error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve registry hierarchy",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 500);
    }
  }
);

// Batch metadata endpoint
app.post("/batch-metadata", async (c) => {
  const { metadataService } = getServices(c.env);

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

    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const batchResponse = await metadataService.getBatchMetadata(
      body.names,
      body.network,
      baseUrl,
    );

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
  const { metadataService } = getServices(c.env);

  try {
    const serviceHealth = await metadataService.healthCheck();

    const health: HealthResponse = {
      service: "ENS Metadata V2",
      version: "2.0.0",
      status: serviceHealth.ensnode === 'ok' &&
              serviceHealth.blockchain.mainnet === 'ok' &&
              serviceHealth.blockchain.sepolia === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: {
        ensnode: serviceHealth.ensnode as 'ok' | 'degraded' | 'error' | 'unknown',
        mainnet: serviceHealth.blockchain.mainnet as 'ok' | 'degraded' | 'error' | 'unknown',
        sepolia: serviceHealth.blockchain.sepolia as 'ok' | 'degraded' | 'error' | 'unknown',
      },
    };

    // Set CF cache headers for health check
    const cacheHeaders = CachePresets.health();
    Object.entries(cacheHeaders).forEach(([key, value]) => {
      c.header(key, value);
    });

    return c.json(health);
  } catch (error) {
    console.error("Health check error:", error);
    const errorResponse: ErrorResponse = {
      error: "Health check failed",
      timestamp: new Date().toISOString(),
    };

    // Set error cache headers
    const errorCacheHeaders = CachePresets.error();
    Object.entries(errorCacheHeaders).forEach(([key, value]) => {
      c.header(key, value);
    });

    return c.json(errorResponse, 500);
  }
});


// Image generation endpoint: /{network}/{registryType}/{identifier}/image
app.get(
  "/:network/:registryType/:identifier/image",
  validateNetwork,
  validateRegistryType,
  validateIdentifier,
  async (c) => {
    const { identifier } = c.req.param();
    const { imageService, imageCacheService } = getImageServices(c.env);

    try {
      // Get query parameters for customization
      const status = c.req.query('status');
      const style = c.req.query('style');
      const bg = c.req.query('bg');
      const width = c.req.query('w');
      const height = c.req.query('h');

      // Build image options
      const options: ImageGenerationOptions = { name: identifier };

      if (status) options.migrationStatus = status as 'migrated' | 'native' | 'unmigrated';
      if (style) options.style = style as 'classic' | 'modern' | 'minimal';
      if (bg) options.background = bg as 'gradient' | 'solid' | 'pattern';
      if (width && height) {
        options.size = {
          width: parseInt(width, 10),
          height: parseInt(height, 10),
        };
      }

      // Validate options
      const validation = imageService.validateOptions(options);
      if (!validation.valid) {
        const errorResponse: ErrorResponse = {
          error: `Invalid image parameters: ${validation.errors.join(', ')}`,
          timestamp: new Date().toISOString(),
        };
        return c.json(errorResponse, 400);
      }

      // Default migration status for images
      if (!status) {
        options.migrationStatus = 'unmigrated';
      }

      // Use tiered cache: L1 KV → L2 R2 → L3 Origin
      const result = await imageCacheService.getImage(identifier, options, c.executionCtx);

      // Set cache headers based on TTL config
      const { ttlConfig, cacheStatus } = result;
      c.header('X-Cache-Status', cacheStatus);
      c.header('Cache-Control', `public, max-age=${ttlConfig.softTtl}, stale-while-revalidate=${ttlConfig.hardTtl - ttlConfig.softTtl}`);

      return c.text(result.svg, 200, {
        'Content-Type': result.contentType,
      });
    } catch (error) {
      console.error("Image generation error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to generate image",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 500);
    }
  }
);

// Webhook endpoint for cache invalidation
app.post("/webhook/ensnode", async (c) => {
  const { webhookService } = getServices(c.env);

  try {
    return await webhookService.handleWebhook(c);
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
