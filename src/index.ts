import { Hono } from "hono";
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
import type {
  MetadataResponse,
  MigrationStatusResponse,
  RegistryHierarchyResponse,
  BatchMetadataResponse,
  CrossChainSyncResponse,
  HealthResponse,
  ErrorResponse,
} from "./types/api";

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
  NAMECHAIN_RPC_URL: string;
  MAINNET_FALLBACK_RPC_1?: string;
  MAINNET_FALLBACK_RPC_2?: string;
  MAINNET_FALLBACK_RPC_3?: string;
  NAMECHAIN_FALLBACK_RPC_1?: string;
  NAMECHAIN_FALLBACK_RPC_2?: string;
  LOG_LEVEL: string;
}

const app = new Hono<{ Bindings: Env }>();

// Service instances (initialized per request)
function getServices(env: Env) {
  const cacheService = new CacheService(env.METADATA_CACHE);

  const metadataService = new MetadataService(
    {
      ensnodeEndpoint: env.ENSNODE_GRAPHQL_URL,
      fallbackToBlockchain: true,
      cacheEnabled: true,
      d1Enabled: true, // Enable D1 sync
    },
    env.METADATA_CACHE,
    {
      MAINNET_RPC_URL: env.MAINNET_RPC_URL,
      NAMECHAIN_RPC_URL: env.NAMECHAIN_RPC_URL,
      MAINNET_FALLBACK_RPC_1: env.MAINNET_FALLBACK_RPC_1,
      MAINNET_FALLBACK_RPC_2: env.MAINNET_FALLBACK_RPC_2,
      MAINNET_FALLBACK_RPC_3: env.MAINNET_FALLBACK_RPC_3,
      NAMECHAIN_FALLBACK_RPC_1: env.NAMECHAIN_FALLBACK_RPC_1,
      NAMECHAIN_FALLBACK_RPC_2: env.NAMECHAIN_FALLBACK_RPC_2,
    },
    env.DB // Pass D1 database
  );

  const webhookService = new WebhookService(cacheService, {
    requireAuth: false, // TODO: Configure based on environment
  });

  return { metadataService, webhookService, cacheService };
}

// Middleware
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

app.use("/cross-chain-sync/*", cache({
  cacheName: "crosschain-cache",
  cacheControl: "max-age=60", // 1 minute (cross-chain comparison changes frequently)
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
    const { metadataService } = getServices(c.env);

    try {
      const metadata = await metadataService.getMetadata(
        network as 'mainnet' | 'namechain',
        registryType as 'registry' | 'namewrapper',
        identifier
      );

      return c.json(metadata);
    } catch (error) {
      console.error("Metadata resolution error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to resolve metadata",
        timestamp: new Date().toISOString(),
      };
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
      return c.json(migrationStatus);
    } catch (error) {
      console.error("Migration status error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to check migration status",
        timestamp: new Date().toISOString(),
      };
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

// Cross-chain sync endpoint - for monitoring migration contract behavior
app.get(
  "/cross-chain-sync/:name",
  validateEnsNameParam,
  async (c) => {
    const { name } = c.req.param();
    const { metadataService } = getServices(c.env);

    try {
      const syncResult = await metadataService.getCrossChainSync(name);
      return c.json(syncResult);
    } catch (error) {
      console.error("Cross-chain sync error:", error);
      const errorResponse: ErrorResponse = {
        error: error instanceof Error ? error.message : "Failed to compare cross-chain data",
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

    const batchResponse = await metadataService.getBatchMetadata(
      body.names,
      body.network
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
              serviceHealth.blockchain.namechain === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: {
        ensnode: serviceHealth.ensnode as 'ok' | 'degraded' | 'error' | 'unknown',
        mainnet: serviceHealth.blockchain.mainnet as 'ok' | 'degraded' | 'error' | 'unknown',
        namechain: serviceHealth.blockchain.namechain as 'ok' | 'degraded' | 'error' | 'unknown',
      },
    };

    return c.json(health);
  } catch (error) {
    console.error("Health check error:", error);
    const errorResponse: ErrorResponse = {
      error: "Health check failed",
      timestamp: new Date().toISOString(),
    };
    return c.json(errorResponse, 500);
  }
});

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
