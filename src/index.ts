import "./shims";
import { Hono, type Context } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { timeout } from "hono/timeout";
import { HTTPException } from "hono/http-exception";
import {
  validateNetwork,
  validateEnsNameParam,
  rateLimiter,
  requestLogger,
} from "./middleware/validation";
import { MetadataService, DomainExpiredError } from "./services/metadata";
import { canonicalizeName, isResolvableEnsName } from "./utils/ens";
import { WebhookService, type EnsNameEvent } from "./services/webhook";
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
import { type MigrationStatus, type NetworkName, isNetworkName, isMigrationStatus, NETWORKS, SUPPORTED_NETWORKS } from "./types";
import { NotFoundError, UpstreamError, InvalidNameError, InvalidTokenIdError } from "./services/errors";
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
  ENSNODE_SEPOLIA_V2_URL: string;
  ENSNODE_SEPOLIA_V1_URL?: string;
  MAINNET_RPC_URL: string;
  SEPOLIA_RPC_URL: string;
  MAINNET_FALLBACK_RPC_1?: string;
  MAINNET_FALLBACK_RPC_2?: string;
  MAINNET_FALLBACK_RPC_3?: string;
  SEPOLIA_FALLBACK_RPC_1?: string;
  SEPOLIA_FALLBACK_RPC_2?: string;
  WEBHOOK_SECRET?: string;
  WEBHOOK_TOLERANCE_SECS?: string;
  WEBHOOK_ALLOW_UNAUTHENTICATED?: string; // local dev only: accept webhooks without a secret
  RATE_LIMIT_DISABLED?: string;
  MAX_AVATAR_BYTES?: string; // max fetched avatar size in bytes (default 25 MB)
  LOG_LEVEL: string;
}

const app = new Hono<{ Bindings: Env }>();

// CF Cache API helper — Workers exposes caches.default but TS lib types don't include it
function getCfCache(): Cache | null {
  try {
    return typeof caches !== 'undefined' ? (caches as any).default : null;
  } catch { return null; }
}

// Max TTL for the L0 edge cache (caches.default). It is PER-COLO and cannot be
// purged globally by the webhook, so its staleness is bounded here rather than
// honoring the (long, per-migration-status) client Cache-Control. The long,
// globally-purgeable TTLs live in KV (L1) + R2 (L2), which the webhook DOES purge;
// after this short window a colo re-fetches and picks up the purged-fresh data.
const EDGE_CACHE_MAX_AGE_SECS = 300;

// L0 edge cache (caches.default) helpers — one consistent mechanism for all GET
// read routes. `match` returns a fresh Response on hit; `put` stores only OK
// responses with a bounded edge TTL (see above) while leaving the client-facing
// Cache-Control on the returned response untouched.
async function edgeCacheMatch(c: any): Promise<Response | null> {
  const cfCache = getCfCache();
  if (!cfCache) return null;
  const cached = await cfCache.match(c.req.url);
  return cached ? new Response(cached.body, cached) : null;
}

function edgeCachePut(c: any, response: Response): void {
  const cfCache = getCfCache();
  if (cfCache && response.ok) {
    // Store a clone with a capped Cache-Control so the per-colo edge entry expires
    // quickly; the original `response` returned to the caller keeps its own header.
    const clone = response.clone();
    const headers = new Headers(clone.headers);
    headers.set('Cache-Control', `public, max-age=${EDGE_CACHE_MAX_AGE_SECS}`);
    const edgeCopy = new Response(clone.body, { status: clone.status, statusText: clone.statusText, headers });
    c.executionCtx.waitUntil(cfCache.put(c.req.url, edgeCopy));
  }
}

// Central error → HTTP response mapper. Maps the resolution-layer error taxonomy
// to status codes and returns GENERIC client messages (internal detail is logged,
// never leaked). Replaces per-route `error.message.includes(...)` string-sniffing.
function httpError(c: any, error: unknown, fallbackMessage: string): Response {
  const timestamp = new Date().toISOString();
  if (error instanceof DomainExpiredError) {
    return c.json({ message: error.message, timestamp }, 410 as any);
  }
  if (error instanceof InvalidNameError) {
    return c.json({ error: 'Invalid ENS name format', timestamp }, 400);
  }
  if (error instanceof InvalidTokenIdError) {
    return c.json({ error: 'Invalid token id', timestamp }, 400);
  }
  if (error instanceof NotFoundError) {
    return c.json({ error: 'Not found', timestamp }, 404);
  }
  if (error instanceof UpstreamError) {
    return c.json({ error: 'Upstream data source temporarily unavailable', timestamp }, 503);
  }
  console.error(`${fallbackMessage}:`, error);
  return c.json({ error: fallbackMessage, timestamp }, 500);
}

// Reduce a set of dependency health strings to the worst one (for /health rollups).
function worstStatus(...statuses: string[]): 'ok' | 'degraded' | 'error' {
  const rank: Record<string, number> = { ok: 0, degraded: 1, fallback: 1, error: 2, unknown: 2 };
  const worst = Math.max(0, ...statuses.map((s) => rank[s] ?? 2));
  return worst === 0 ? 'ok' : worst === 1 ? 'degraded' : 'error';
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

function getRpcUrl(env: Env, network: NetworkName): string {
  return env[NETWORKS[network].rpcUrlEnvKey];
}

function getIndexerV2Url(env: Env, network: NetworkName): string {
  return env[NETWORKS[network].indexerV2UrlEnvKey];
}

function getImageServices(env: Env, network: NetworkName): ImageServices {
  const cached = _imageServices.get(network);
  if (cached) return cached;

  // Invalid/garbage value → undefined → AvatarService uses its built-in default.
  const parsedMax = parseInt(env.MAX_AVATAR_BYTES ?? '', 10);
  const maxAvatarBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined;
  // v2 universal resolver (when configured for this network) so native-v2 names'
  // avatar/header records resolve; AvatarService ignores the unset placeholder.
  const universalResolverV2 = NETWORKS[network].v2?.universalResolver;
  const avatarService = new AvatarService(getRpcUrl(env, network), NETWORKS[network].chain, maxAvatarBytes, universalResolverV2);
  const imageService = new ImageGenerationService(avatarService);
  const storageManager = new StorageManager(env.ASSET_BUCKET);
  const imageCacheService = new ImageCacheService(env.SVG_CACHE, storageManager, imageService, avatarService, network, env.ASSET_BUCKET);
  const services = { avatarService, imageService, imageCacheService };
  _imageServices.set(network, services);
  return services;
}

function getServices(env: Env, network: NetworkName): FullServices {
  const cached = _fullServices.get(network);
  if (cached) return cached;

  const cacheService = new CacheService(env.METADATA_CACHE);

  const metadataService = new MetadataService(
    {
      indexerV2Endpoint: getIndexerV2Url(env, network),
      indexerV2ApiVersion: NETWORKS[network].indexerV2ApiVersion,
      // Optional v1 ENSNode subgraph fallback (sepolia: v1 names absent from zigens).
      indexerV1Endpoint: NETWORKS[network].indexerV1UrlEnvKey
        ? env[NETWORKS[network].indexerV1UrlEnvKey!]
        : undefined,
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
      // Fail-closed by default: no secret ⇒ reject. Opt out only for local dev.
      allowUnauthenticated: env.WEBHOOK_ALLOW_UNAUTHENTICATED === 'true',
      toleranceSecs: env.WEBHOOK_TOLERANCE_SECS ? parseInt(env.WEBHOOK_TOLERANCE_SECS, 10) : undefined,
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

// NOTE: the previous Hono `cache()` middlewares were removed. They (a) targeted
// `/*/metadata/*`, which never matches the real metadata routes
// (`/:network/:registryType/:name`), so that one was dead; (b) relied on
// `caches.open(<named>)`, which Cloudflare Workers does not support (only
// `caches.default`); and (c) would have clobbered the per-status
// stale-while-revalidate `Cache-Control` the handlers set. L0 edge caching is
// now done consistently via `edgeCacheMatch`/`edgeCachePut` (caches.default),
// honoring each handler's own Cache-Control — the same mechanism the image and
// rasterize routes already use.

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
    // validateNetwork middleware guarantees a valid value; narrow the type.
    const network = c.req.param("network") as NetworkName;
    const name = c.req.param("name");
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
      return httpError(c, error, "Failed to resolve avatar");
    }
  }
);

// Avatar metadata endpoint (v1 parity): /{network}/avatar/{name}/meta
// Returns the avatar record's metadata JSON (NFT host_meta, is_owner, image_url,
// etc.) — the metadata sibling of the avatar image route above. `avatar` is a
// static segment, so this doesn't collide with the generic
// `/:network/:param2/:param3/(image|rasterize)` NFT routes.
app.get(
  "/:network/avatar/:name/meta",
  validateNetwork,
  validateEnsNameParam,
  async (c) => {
    // L0 edge cache — same read-through as the other metadata (JSON) endpoints.
    const edgeHit = await edgeCacheMatch(c);
    if (edgeHit) return edgeHit;

    // validateNetwork middleware guarantees a valid value; narrow the type.
    const network = c.req.param("network") as NetworkName;
    const name = c.req.param("name");
    const { avatarService } = getImageServices(c.env, network);

    try {
      const url = new URL(c.req.url);
      const baseUrl = `${url.protocol}//${url.host}`;
      // For inline (image_data) avatars, v1 pointed `image` at the avatar image
      // endpoint; keep that shape using this deployment's own host.
      const avatarImageUrl = `${baseUrl}/${network}/avatar/${encodeURIComponent(name)}`;

      const meta = await avatarService.getAvatarMeta(name, avatarImageUrl);
      if (!meta) {
        return c.json({ message: "No results found." }, 404);
      }

      c.header('Cache-Control', 'public, max-age=3600');
      const res = c.json(meta);
      edgeCachePut(c, res);
      return res;
    } catch (error) {
      return httpError(c, error, "Failed to resolve avatar metadata");
    }
  }
);

// Header/banner endpoint: /{network}/header/{name} (the `header` text record)
app.get(
  "/:network/header/:name",
  validateNetwork,
  validateEnsNameParam,
  async (c) => {
    // validateNetwork middleware guarantees a valid value; narrow the type.
    const network = c.req.param("network") as NetworkName;
    const name = c.req.param("name");
    const { avatarService } = getImageServices(c.env, network);

    try {
      const header = await avatarService.getHeaderImage(name);
      if (!header) {
        return c.json({ message: `No header set for ${name}` } as any, 404);
      }

      return new Response(new Uint8Array(header.buffer), {
        status: 200,
        headers: {
          'Content-Type': header.mimeType,
          'Content-Length': header.buffer.length.toString(),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      return httpError(c, error, "Failed to resolve header");
    }
  }
);

// Shared metadata handler — used by both v1 (tokenId) and v2 (name) routes
async function handleMetadata(
  c: any,
  network: NetworkName,
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
      network,
      registryType as 'registry' | 'namewrapper',
      name,
      baseUrl,
    ),
  );

  c.header('X-Cache-Status', cacheStatus);
  c.header('Cache-Control', `public, max-age=${ttlConfig.softTtl}, stale-while-revalidate=${ttlConfig.hardTtl - ttlConfig.softTtl}`);
  const res = c.json(metadata);
  // L0 edge: store with the per-status Cache-Control set above (gives metadata
  // the edge hop it previously lacked, without breaking SWR).
  edgeCachePut(c, res);
  return res;
}

// Shared image handler — used by both v1 (tokenId) and v2 (name) routes.
// The L0 edge-cache short-circuit happens in the route BEFORE checkExpiry, so by
// the time we're here it's a confirmed edge miss and we only need to generate+store.
async function handleImage(c: any, network: NetworkName, name: string) {
  const { imageService, imageCacheService } = getImageServices(c.env, network);

  // Only honor `?status=` if it's a real MigrationStatus — otherwise an arbitrary
  // value would render a bogus badge AND segment/pollute the image cache key.
  const statusParam = c.req.query('status');
  const width = c.req.query('w');
  const height = c.req.query('h');

  const options: ImageGenerationOptions = { name };
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

  // Single resolution: enforces existence (throws NotFoundError → 404 for an
  // unregistered name) AND yields the authoritative badge status. A valid
  // `?status=` overrides only the rendered badge, never the existence gate
  // (otherwise a bogus status could render an NFT for a nonexistent name).
  const { metadataService } = getServices(c.env, network);
  const resolvedStatus = await metadataService.resolveStatusForImage(network, name);
  options.migrationStatus = isMigrationStatus(statusParam) ? statusParam : resolvedStatus;

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
  edgeCachePut(c, response);

  return response;
}

// Helper to check if a param is a contract address (0x-prefixed, 42 chars)
function isContractAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// The 400 for a name route (`registry` / `namewrapper`) whose name this service
// can never look up (see isResolvableEnsName), answered before any other work,
// the edge cache included. A contract-address route names a token id instead.
function invalidNameResponse(c: Context): Response | null {
  const param2 = c.req.param("param2");
  if ((param2 === 'registry' || param2 === 'namewrapper') && !isResolvableEnsName(c.req.param("param3") ?? '')) {
    return c.json({ error: "Invalid ENS name format", timestamp: new Date().toISOString() }, 400);
  }
  return null;
}

// Unified metadata endpoint: handles both v1 (contractAddress/tokenId) and v2 (registryType/name)
app.get(
  "/:network/:param2/:param3",
  validateNetwork,
  async (c) => {
    const invalidName = invalidNameResponse(c);
    if (invalidName) return invalidName;

    // L0 edge: short-circuit before any RPC/indexer work.
    const edgeHit = await edgeCacheMatch(c);
    if (edgeHit) return edgeHit;

    // validateNetwork middleware guarantees a valid value; narrow the type.
    const network = c.req.param("network") as NetworkName;
    const param2 = c.req.param("param2");
    const param3 = c.req.param("param3");

    try {
      // v1 route: param2 is a contract address (0x-prefixed hex)
      if (isContractAddress(param2)) {
        const { metadataService } = getServices(c.env, network);
        const { name, registryType } = await metadataService.resolveTokenId(
          network,
          param2,
          param3,
        );
        return await handleMetadata(c, network, registryType, name);
      }

      // v2 route: param2 is registryType
      if (param2 === 'registry' || param2 === 'namewrapper') {
        return await handleMetadata(c, network, param2, param3);
      }

      return c.json({ error: "Invalid route. Second parameter must be 'registry', 'namewrapper', or a contract address", timestamp: new Date().toISOString() }, 400);
    } catch (error) {
      // Don't cache server errors at the edge.
      if (!(error instanceof DomainExpiredError) && !(error instanceof NotFoundError)) {
        const errorCacheHeaders = CachePresets.error();
        Object.entries(errorCacheHeaders).forEach(([key, value]) => c.header(key, value));
      }
      return httpError(c, error, "Failed to resolve metadata");
    }
  }
);

// Migration status endpoint
app.get(
  "/migration-status/:name",
  validateEnsNameParam,
  async (c) => {
    const edgeHit = await edgeCacheMatch(c);
    if (edgeHit) return edgeHit;

    const { name } = c.req.param();
    const network = c.req.query('network') || 'mainnet';
    if (network !== 'mainnet' && network !== 'sepolia') {
      return c.json({ error: "Invalid network. Must be 'mainnet' or 'sepolia'", timestamp: new Date().toISOString() }, 400);
    }
    const { metadataService } = getServices(c.env, network);

    try {
      await metadataService.checkExpiry(name);

      const migrationStatus = await metadataService.getMigrationStatus(name);

      const cacheHeaders = CachePresets.migrationStatus(name);
      Object.entries(cacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      const res = c.json(migrationStatus);
      edgeCachePut(c, res);
      return res;
    } catch (error) {
      if (!(error instanceof DomainExpiredError) && !(error instanceof NotFoundError)) {
        const errorCacheHeaders = CachePresets.error();
        Object.entries(errorCacheHeaders).forEach(([key, value]) => c.header(key, value));
      }
      return httpError(c, error, "Failed to check migration status");
    }
  }
);

// Registry hierarchy endpoint
app.get(
  "/registry-hierarchy/:name",
  validateEnsNameParam,
  async (c) => {
    const edgeHit = await edgeCacheMatch(c);
    if (edgeHit) return edgeHit;

    const { name } = c.req.param();
    const network = c.req.query('network') || 'mainnet';
    if (network !== 'mainnet' && network !== 'sepolia') {
      return c.json({ error: "Invalid network. Must be 'mainnet' or 'sepolia'", timestamp: new Date().toISOString() }, 400);
    }
    const { metadataService } = getServices(c.env, network);

    try {
      await metadataService.checkExpiry(name);

      const hierarchy = await metadataService.getRegistryHierarchy(name);

      const cacheHeaders = CachePresets.hierarchy(name);
      Object.entries(cacheHeaders).forEach(([key, value]) => {
        c.header(key, value);
      });

      const res = c.json(hierarchy);
      edgeCachePut(c, res);
      return res;
    } catch (error) {
      if (!(error instanceof DomainExpiredError) && !(error instanceof NotFoundError)) {
        const errorCacheHeaders = CachePresets.error();
        Object.entries(errorCacheHeaders).forEach(([key, value]) => c.header(key, value));
      }
      return httpError(c, error, "Failed to resolve registry hierarchy");
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

    const network: NetworkName = body.network ?? 'mainnet';
    if (!isNetworkName(network)) {
      return c.json({ error: "Invalid network. Must be 'mainnet' or 'sepolia'", timestamp: new Date().toISOString() }, 400);
    }
    const registryType = body.registryType || 'registry';
    if (registryType !== 'registry' && registryType !== 'namewrapper') {
      return c.json({ error: "Invalid registryType. Must be 'registry' or 'namewrapper'", timestamp: new Date().toISOString() }, 400);
    }
    const { metadataService, metadataCacheService } = getServices(c.env, network);
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Resolve each name through the metadata cache (KV + SWR)
    const results = await Promise.allSettled(
      body.names.map(async (name: string) => {
        try {
          // Same expiry gate as the single-name route (before the cache): an
          // expired name's KV entry must not be served until hardTtl. checkExpiry
          // is v2-aware and fails open on outages.
          await metadataService.checkExpiry(name);
          const { metadata } = await metadataCacheService.get(
            network,
            registryType,
            name,
            c.executionCtx,
            () => metadataService.getMetadata(
              network,
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
    return httpError(c, error, "Failed to process batch metadata request");
  }
});

// Health check with detailed status
app.get("/health", async (c) => {
  try {
    // Probe BOTH indexers: the mainnet ENSNode subgraph AND the sepolia zigens
    // (v2) indexer — the latter backs the entire v2 path and would otherwise go
    // unmonitored. Blockchain health (both RPCs) is the same from either service.
    const [mainnetHealth, sepoliaHealth] = await Promise.race([
      Promise.all([
        getServices(c.env, 'mainnet').metadataService.healthCheck(),
        getServices(c.env, 'sepolia').metadataService.healthCheck(),
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 15000)),
    ]);

    // Indexer dependency = worst of the two indexers (a zigens outage must surface).
    const indexerStatus = worstStatus(mainnetHealth.indexerV2, sepoliaHealth.indexerV2);
    const mainnetRpc = mainnetHealth.blockchain.mainnet;
    const sepoliaRpc = mainnetHealth.blockchain.sepolia;

    const health: HealthResponse = {
      service: "ENS Metadata V2",
      version: "2.0.0",
      status: indexerStatus === 'ok' && mainnetRpc === 'ok' && sepoliaRpc === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: {
        indexer: indexerStatus,
        mainnet: mainnetRpc as 'ok' | 'degraded' | 'error' | 'unknown',
        sepolia: sepoliaRpc as 'ok' | 'degraded' | 'error' | 'unknown',
      },
      latency: {
        indexer: mainnetHealth.indexerV2Latency,
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
    const invalidName = invalidNameResponse(c);
    if (invalidName) return invalidName;

    // validateNetwork middleware guarantees a valid value; narrow the type.
    const network = c.req.param("network") as NetworkName;
    const param2 = c.req.param("param2");
    const param3 = c.req.param("param3");

    try {
      // L0 edge: short-circuit before any tokenId resolution, expiry RPC, or render.
      const edgeHit = await edgeCacheMatch(c);
      if (edgeHit) return edgeHit;

      let name: string;

      if (isContractAddress(param2)) {
        // v1: resolve tokenId to name
        const { metadataService } = getServices(c.env, network);
        const resolved = await metadataService.resolveTokenId(
          network,
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

      // Don't render an NFT for an expired name. Existence (→404 if unregistered)
      // and the badge status are resolved together inside handleImage in one pass.
      const { metadataService } = getServices(c.env, network);
      await metadataService.checkExpiry(name);   // → 410 if expired

      return await handleImage(c, network, name);
    } catch (error) {
      return httpError(c, error, "Failed to generate image");
    }
  }
);

// Unified rasterize endpoint: SVG → PNG via rasterize-wasm
app.get(
  "/:network/:param2/:param3/rasterize",
  validateNetwork,
  async (c) => {
    const invalidName = invalidNameResponse(c);
    if (invalidName) return invalidName;

    // validateNetwork middleware guarantees a valid value; narrow the type.
    const network = c.req.param("network") as NetworkName;
    const param2 = c.req.param("param2");
    const param3 = c.req.param("param3");

    try {
      let name: string;

      if (isContractAddress(param2)) {
        const { metadataService } = getServices(c.env, network);
        const resolved = await metadataService.resolveTokenId(
          network,
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

      // Don't render an NFT for an expired name (existence is enforced below via
      // the single resolveStatusForImage pass, which also gives the badge status).
      const { metadataService } = getServices(c.env, network);
      await metadataService.checkExpiry(name);   // → 410 if expired

      // Get the SVG (reuses image pipeline)
      const { imageService, imageCacheService } = getImageServices(c.env, network);

      // Only honor a valid MigrationStatus (see handleImage) — ignore arbitrary input.
      const statusParam = c.req.query('status');
      const outputWidth = c.req.query('w') ? parseInt(c.req.query('w')!, 10) : null;
      const outputHeight = c.req.query('h') ? parseInt(c.req.query('h')!, 10) : null;

      const options: ImageGenerationOptions = { name };

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
      // Single resolution: existence gate (→404 unregistered) + badge status;
      // a valid ?status= overrides only the badge (see handleImage).
      const resolvedStatus = await metadataService.resolveStatusForImage(network, name);
      options.migrationStatus = isMigrationStatus(statusParam) ? statusParam : resolvedStatus;

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

      // Store in CF edge cache with the shared capped TTL — caches.default is
      // per-colo and unpurgeable by the webhook, so the full softTtl (hours)
      // must never reach it (see EDGE_CACHE_MAX_AGE_SECS).
      edgeCachePut(c, pngResponse);

      return pngResponse;
    } catch (error) {
      return httpError(c, error, "Failed to rasterize image");
    }
  }
);

// Webhook endpoint for cache invalidation + proactive warming. Sender-agnostic:
// any backend that knows a name changed can POST the EnsNameEvent contract here
// (see services/webhook.ts) — the indexer is just the current caller.
const handleWebhook = async (c: any) => {
  // Clone before the service consumes the body, so we can read it for warming
  // without interfering with signature verification (which reads c.req.text()).
  const bodyClone = c.req.raw.clone();
  const { webhookService } = getServices(c.env, 'mainnet');

  try {
    const response = await webhookService.handleWebhook(c);

    // Only purge/warm when the webhook was accepted (validated + processed).
    if (response.status >= 200 && response.status < 300) {
      c.executionCtx.waitUntil((async () => {
        try {
          const payload = await bodyClone.json() as Partial<EnsNameEvent>;
          // Canonicalize like WebhookService does for its purges: the D1 name
          // column and warmed cache keys must never carry a raw-case variant.
          const name = payload?.name ? canonicalizeName(payload.name) : undefined;
          if (!name) return;

          // The event carries ENS protocol (v1/v2), not chain — and the chain
          // cannot be derived from the payload (v1 contracts share addresses
          // across chains, and a v2-dialect indexer like zigens emits v1 events
          // for legacy activity on ITS chain too). So: v2 events target the
          // networks whose indexer speaks v2 (config-derived — mainnet joins
          // automatically when it flips), while v1 events could concern ANY
          // network; the per-network existence gate below cheaply skips chains
          // where the name doesn't resolve, so wrong-chain warming is a no-op.
          const targetNetworks = payload.protocol === 'v2'
            ? SUPPORTED_NETWORKS.filter((n) => NETWORKS[n].indexerV2ApiVersion === 'v2')
            : SUPPORTED_NETWORKS;

          // Purge L0 edge cache for every URL shape that could hold this name:
          // all networks × {registry, namewrapper} × {image, rasterize}. (L0 only
          // caches images/rasterize; metadata/migration-status carry their own
          // short TTLs and are also flushed at L1/L2 by the service.)
          const cfCache = getCfCache();
          if (cfCache) {
            const origin = new URL(c.req.url).origin;
            const purges: Promise<boolean>[] = [];
            for (const net of SUPPORTED_NETWORKS) {
              for (const rt of ['registry', 'namewrapper']) {
                for (const kind of ['image', 'rasterize']) {
                  purges.push(cfCache.delete(new Request(`${origin}/${net}/${rt}/${name}/${kind}`)));
                }
              }
            }
            await Promise.all(purges);
          }

          // Per matching network: re-classify fresh, persist the new status to
          // D1 (so the last-resort tier reflects the event instead of a stale
          // value), and warm the default image. resolveStatusForImage enforces
          // existence (NotFoundError on the wrong chain / burned names) and
          // propagates outages (UpstreamError) — either skips the persist, so a
          // transient failure can never clobber a correct D1 row with an
          // error-fallback "unmigrated".
          for (const net of targetNetworks) {
            try {
              const { imageCacheService } = getImageServices(c.env, net);
              const { metadataService } = getServices(c.env, net);
              // strict: a degraded badge default is fine to RENDER, but never
              // to PERSIST — outages must throw here, not classify.
              const migrationStatus: MigrationStatus = await metadataService.resolveStatusForImage(net, name, { strict: true });
              await metadataService.recordMigrationStatus(name, migrationStatus);
              await imageCacheService.getImage(name, { name, migrationStatus }, c.executionCtx);
              console.log(`[webhook] warmed image cache for ${name} on ${net} (${migrationStatus})`);
            } catch (err) {
              console.warn(`[webhook] skipped warm/persist for ${name} on ${net} (no D1 write):`, err);
            }
          }
        } catch (err) {
          console.warn('[webhook] cache warming failed:', err);
        }
      })());
    }

    return response;
  } catch (error) {
    console.error("Webhook handling error:", error);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
};

app.post("/webhook", handleWebhook);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

// Error handler. Honor HTTPException (e.g. the timeout middleware's 504 Gateway
// Timeout) so its status isn't flattened to a generic 500; everything else is a
// real unhandled error → 500. Exported for direct testing.
export function errorHandler(err: unknown, c: any): Response | Promise<Response> {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error", timestamp: new Date().toISOString() }, 500);
}

app.onError(errorHandler);


export default app;
