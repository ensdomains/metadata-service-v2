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
  WEBHOOK_SECRET?: string;
  LOG_LEVEL: string;
}

const app = new Hono<{ Bindings: Env }>();

// Lightweight services (no heavy initialization)
function getRpcUrl(env: Env, network: string): string {
  return network === 'sepolia' ? env.SEPOLIA_RPC_URL : env.MAINNET_RPC_URL;
}

function getImageServices(env: Env, network: string) {
  const avatarService = new AvatarService(getRpcUrl(env, network));
  const imageService = new ImageGenerationService(avatarService);
  const storageManager = new StorageManager(env.ASSET_BUCKET);
  const imageCacheService = new ImageCacheService(env.SVG_CACHE, storageManager, imageService, avatarService);
  return { avatarService, imageService, imageCacheService };
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
    {
      requireAuth: !!env.WEBHOOK_SECRET,
      secret: env.WEBHOOK_SECRET,
    },
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
  const { metadataService, metadataCacheService } = getServices(c.env);
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
  c.header('X-Cache-Status', cacheStatus);
  c.header('Cache-Control', `public, max-age=${ttlConfig.softTtl}, stale-while-revalidate=${ttlConfig.hardTtl - ttlConfig.softTtl}`);

  return c.text(result.svg, 200, { 'Content-Type': result.contentType });
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
        const { metadataService } = getServices(c.env);
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
      console.error("Metadata resolution error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve metadata",
        timestamp: new Date().toISOString(),
      };

      // Use 404 for tokenId resolution failures, 500 for others
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

      const cacheHeaders = CachePresets.hierarchy(name);
      Object.entries(cacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      return c.json(hierarchy);
    } catch (error) {
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
        const { metadataService } = getServices(c.env);
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

      return await handleImage(c, network, name);
    } catch (error) {
      console.error("Image generation error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to generate image",
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, error instanceof Error && error.message.includes('No domain found') ? 404 : 500);
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
