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
import { securityHeaders } from "./middleware/security-headers";
import { MetadataService, DomainExpiredError } from "./services/metadata";
import { canonicalizeName, validateEnsName, isResolvableEnsName } from "./utils/ens";
import { WebhookService, type EnsNameEvent } from "./services/webhook";
import { CacheService } from "./services/cache";
import { runD1Retention } from "./services/d1";
import { ImageGenerationService } from "./services/image";
import { AvatarService } from "./services/avatar";
import { parseIpfsGateway } from "./services/ipfs-gateway";
import { ImageCacheService, type ImageCacheResult } from "./services/image-cache";
import { MetadataCacheService } from "./services/metadata-cache";
import { StorageManager } from "./utils/storage";
import { withRequestBudget } from "./services/request-budget";
import { withServingHost } from "./services/media-fetch";
import { RasterizeService } from "./services/rasterize";
import { MEDIA_SECURITY_HEADERS } from "./services/media-safety";
const rasterizeService = new RasterizeService();
import { CachePresets } from "./utils/cache-headers";
import { installConsoleRedaction, registerLogSecrets } from "./utils/log-redaction";
import type {
  HealthResponse,
  ErrorResponse,
  MetadataResponse,
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

  // Rate Limiting bindings, one per rate-limit bucket (wrangler.toml
  // [[ratelimits]]). A missing one makes that bucket use the KV counter.
  RATE_LIMITER_DEFAULT?: RateLimit;
  RATE_LIMITER_BATCH?: RateLimit;
  RATE_LIMITER_WEBHOOK?: RateLimit;
  RATE_LIMITER_RASTERIZE?: RateLimit;
  RATE_LIMITER_IMAGE?: RateLimit;

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
  D1_READ_MAX_AGE_SECS?: string; // D1 rows older than this are a miss (default 7 days)
  D1_RETENTION_SECS?: string; // daily cron deletes D1 rows older than this (default 30 days)
  MAX_BATCH_NAMES?: string; // max names per POST /batch-metadata (default 100)
  IPFS_GATEWAY?: string; // https origin of the IPFS gateway for avatar media (default ipfs.filebase.io)
  LOG_LEVEL: string;
}

// Hono env of this app. Routes, middleware and the helpers below are typed with
// it, so `c.env` keeps the binding types above.
export type AppEnv = { Bindings: Env };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

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

// How long an NFT card rendered without its avatar because the avatar lookup
// failed (RPC, CCIP gateway or media host outage, timeout) is cached, by clients
// and in the edge cache. The card is kept out of KV/R2 (ImageCacheService). A
// name whose upstream fails for good (e.g. a CCIP gateway answering 503 for a
// suspended name) is looked up and rendered again once per window per colo,
// not on every request: the edge entry keeps a failing upstream from being hit
// (and the card re-rendered) by every client during an outage. The edge copy is
// served with a fresh max-age of this window, so the avatar shows up within
// about two windows (two minutes) of the upstream recovering. A gateway's final
// answer (a 4xx other than 401, 403, 408 and 429) and a gateway URL the guard
// refuses mean no record, not a failure (avatar.ts), and never degrade a card.
const DEGRADED_CARD_MAX_AGE_SECS = 60;
const DEGRADED_CARD_CACHE_CONTROL = `public, max-age=${DEGRADED_CARD_MAX_AGE_SECS}`;

// Client Cache-Control for an NFT card (SVG or PNG): the per-migration-status
// stale-while-revalidate policy, or the short one above for a degraded card.
function cardCacheControl(result: ImageCacheResult): string {
  if (result.avatarFailed) return DEGRADED_CARD_CACHE_CONTROL;
  const { softTtl, hardTtl } = result.ttlConfig;
  return `public, max-age=${softTtl}, stale-while-revalidate=${hardTtl - softTtl}`;
}

// L0 edge cache (caches.default) helpers — one consistent mechanism for all GET
// read routes. `match` returns a fresh Response on hit; `put` stores only OK
// responses with a bounded edge TTL (see above) while leaving the client-facing
// Cache-Control on the returned response untouched.
async function edgeCacheMatch(c: AppContext): Promise<Response | null> {
  const cfCache = getCfCache();
  if (!cfCache) return null;
  const cached = await cfCache.match(c.req.url);
  return cached ? new Response(cached.body, cached) : null;
}

function edgeCachePut(c: AppContext, response: Response, maxAgeSecs: number = EDGE_CACHE_MAX_AGE_SECS): void {
  const cfCache = getCfCache();
  if (cfCache && response.ok) {
    // Store a clone with a capped Cache-Control so the per-colo edge entry expires
    // quickly; the original `response` returned to the caller keeps its own header.
    const clone = response.clone();
    const headers = new Headers(clone.headers);
    headers.set('Cache-Control', `public, max-age=${maxAgeSecs}`);
    const edgeCopy = new Response(clone.body, { status: clone.status, statusText: clone.statusText, headers });
    c.executionCtx.waitUntil(cfCache.put(c.req.url, edgeCopy));
  }
}

// A media response served from the edge cache, with any of
// MEDIA_SECURITY_HEADERS it was stored without. An entry stored before those
// headers existed can be up to EDGE_CACHE_MAX_AGE_SECS old when a deploy adds
// them (and the KV/R2 card version bump does not reach this URL-keyed cache);
// the headers are what keeps its bytes inert on this origin. A header the entry
// carries is kept, as the security-headers middleware keeps a CSP a handler
// set: every entry is one of this service's own responses.
function withMediaSecurityHeaders(response: Response): Response {
  for (const [header, value] of Object.entries(MEDIA_SECURITY_HEADERS)) {
    if (!response.headers.has(header)) response.headers.set(header, value);
  }
  return response;
}

// Central error → HTTP response mapper. Maps the resolution-layer error taxonomy
// to status codes and returns GENERIC client messages (internal detail is logged,
// never leaked). Replaces per-route `error.message.includes(...)` string-sniffing.
function httpError(c: AppContext, error: unknown, fallbackMessage: string): Response {
  const timestamp = new Date().toISOString();
  if (error instanceof DomainExpiredError) {
    return c.json({ message: error.message, timestamp }, 410);
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

// Optional duration override in seconds → ms. Unset/invalid → undefined, so the
// service's default applies.
// A duration env var in whole seconds, or undefined (the caller's default) when
// it is unset, not a whole number of seconds (e.g. "30d", which parseInt would
// read as 30) or below `minSecs`.
function envSecsToMs(name: string, value: string | undefined, minSecs = 1): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const secs = /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!(secs >= minSecs)) {
    console.warn(`[config] ignoring ${name}=${JSON.stringify(value)}: expected whole seconds, at least ${minSecs}`);
    return undefined;
  }
  return secs * 1000;
}

// A retention below a day is taken for a unit slip (seconds meant as days):
// the next cron run would delete almost every D1 row.
const MIN_D1_RETENTION_SECS = 24 * 60 * 60;

function getImageServices(env: Env, network: NetworkName): ImageServices {
  const cached = _imageServices.get(network);
  if (cached) return cached;

  // Invalid/garbage value → undefined → AvatarService uses its built-in default.
  const parsedMax = parseInt(env.MAX_AVATAR_BYTES ?? '', 10);
  const maxAvatarBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined;
  // v2 universal resolver (when configured for this network) so native-v2 names'
  // avatar/header records resolve; AvatarService ignores the unset placeholder.
  const universalResolverV2 = NETWORKS[network].v2?.universalResolver;
  const avatarService = new AvatarService(
    getRpcUrl(env, network),
    NETWORKS[network].chain,
    maxAvatarBytes,
    universalResolverV2,
    parseIpfsGateway(env.IPFS_GATEWAY),
  );
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
      d1ReadMaxAgeMs: envSecsToMs('D1_READ_MAX_AGE_SECS', env.D1_READ_MAX_AGE_SECS),
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

// Secret env values (RPC URLs carry provider keys) must never reach Workers
// Logs; viem copies request URLs into its errors. Wrap the console once, and
// register this request's secrets before anything can log.
installConsoleRedaction();
app.use("*", async (c, next) => {
  registerLogSecrets([c.env?.MAINNET_RPC_URL, c.env?.SEPOLIA_RPC_URL, c.env?.WEBHOOK_SECRET]);
  await next();
});

// Middleware
// First, so the security headers wrap everything below: other middleware,
// notFound, onError and edge-cache hits (see middleware/security-headers.ts).
app.use("*", securityHeaders);
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
// ?pretty re-indents JSON responses, and indentation grows with nesting depth:
// a small, deeply nested document becomes a huge string (8 KB of nested arrays
// re-indents to 32 MB). The avatar and header routes serve content the name's
// owner controls (the avatar metadata JSON as-is, and the avatar and header
// media), so they are never re-indented. Every other JSON response is built by
// this service from fixed shapes.
const pretty = prettyJSON();
const USER_SHAPED_JSON_ROUTE = /^\/[^/]+\/(avatar\/[^/]+(\/meta)?|header\/[^/]+)$/;
app.use("*", (c, next) => (USER_SHAPED_JSON_ROUTE.test(c.req.path) ? next() : pretty(c, next)));
// 30s timeout for all routes except /health (health has its own graceful handling)
app.use("*", async (c, next) => {
  if (c.req.path === '/health' || c.req.path === '/') return next();
  return timeout(30000)(c, next);
});
app.use("*", rateLimiter);
// Per-request allowance for CCIP-read gateway responses and the upstream
// deadline, under the 30s timeout above (see request-budget.ts).
app.use("*", (_c, next) => withRequestBudget(next));
// Outbound fetches made for this request never target the host it is served on
// (see media-fetch.ts).
app.use("*", (c, next) => withServingHost(new URL(c.req.url).hostname, next));

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
        return c.json({ message: `No avatar set for ${name}` }, 404);
      }

      return new Response(new Uint8Array(avatar.buffer), {
        status: 200,
        headers: {
          ...MEDIA_SECURITY_HEADERS,
          'Content-Type': avatar.mimeType,
          'Content-Length': avatar.buffer.length.toString(),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      // A failed lookup (UpstreamError → 503) is not an answer: keep it short-lived.
      Object.entries(CachePresets.error()).forEach(([key, value]) => c.header(key, value));
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
      // For an inline avatar image the endpoint serves (image_data, a data:image
      // URI or SVG markup), `image` points at the avatar image endpoint on this
      // deployment's own host (v1 did this for image_data), which serves the
      // bytes as ens-avatar resolves them, with any SVG sanitized.
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
      // A failed lookup (UpstreamError → 503) is not an answer: keep it short-lived.
      Object.entries(CachePresets.error()).forEach(([key, value]) => c.header(key, value));
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
        return c.json({ message: `No header set for ${name}` }, 404);
      }

      return new Response(new Uint8Array(header.buffer), {
        status: 200,
        headers: {
          ...MEDIA_SECURITY_HEADERS,
          'Content-Type': header.mimeType,
          'Content-Length': header.buffer.length.toString(),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      // A failed lookup (UpstreamError → 503) is not an answer: keep it short-lived.
      Object.entries(CachePresets.error()).forEach(([key, value]) => c.header(key, value));
      return httpError(c, error, "Failed to resolve header");
    }
  }
);

// Shared metadata handler — used by both v1 (tokenId) and v2 (name) routes
async function handleMetadata(
  c: AppContext,
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
      c.executionCtx,
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
async function handleImage(c: AppContext, network: NetworkName, name: string) {
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
  const { cacheStatus } = result;

  const response = new Response(result.svg, {
    status: 200,
    headers: {
      ...MEDIA_SECURITY_HEADERS,
      'Content-Type': result.contentType,
      'X-Cache-Status': cacheStatus,
      'Cache-Control': cardCacheControl(result),
    },
  });

  // Store in CF edge cache — next identical request returns instantly. A card
  // whose avatar lookup failed only briefly (see DEGRADED_CARD_MAX_AGE_SECS).
  edgeCachePut(c, response, result.avatarFailed ? DEGRADED_CARD_MAX_AGE_SECS : EDGE_CACHE_MAX_AGE_SECS);

  return response;
}

// Helper to check if a param is a contract address (0x-prefixed, 42 chars)
function isContractAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// The token id of a metadata URL. A v2 registry's token URI may end it with
// `.json` (the suffix its URI renderer can append), which names the same token.
function metadataTokenId(param: string): string {
  return param.endsWith('.json') ? param.slice(0, -'.json'.length) : param;
}

// The 400 for a name route (`registry` / `namewrapper`) whose name this service
// can never look up (see isResolvableEnsName), answered before any other work,
// the edge cache included. A contract-address route names a token id instead.
function invalidNameResponse(c: AppContext): Response | null {
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
          metadataTokenId(param3),
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

// POST /batch-metadata limits (WEB-1552). Workers Paid allows 10,000
// subrequests per invocation (fetch and KV count). One distinct name costs,
// counted from the code with each call answering on its first attempt:
//  - indexers down (sepolia): KV get + write-back 2, checkExpiry 2 RPC reads,
//    zigens 2 and v1 subgraph 2 (primary + one retry each), blockchain tier 6
//    (v2 getState; v1 owner, resolver, isWrapped owner, NameWrapper.getData,
//    nameExpires), v2 registry discovery (2 reads per lookup) 4 while not
//    cached = 18;
//  - indexer up and the name's D1 row stale: the D1 sync adds 3 indexer
//    queries = 21;
//  - worst case, a subname of a v2 name with its own subregistry that no
//    indexer covers: the owner's contracts can make the Universal Resolver
//    revert on every RPC client, and the hierarchical resolver then reads 2
//    values per label, one label after another: ~70 with names capped at 32
//    labels (fix/name-depth-cap).
// 100 names stay under 10,000 even then (~7,000), and the time budget below
// and the request deadline stop the work sooner. D1 allows 1000 queries per
// invocation; the D1 sync runs in waitUntil, so on a batch of many cold, deep
// names it is the background sync of the last names that can hit that cap, not
// a response.
const DEFAULT_MAX_BATCH_NAMES = 100;
// Distinct names resolved at once: an invocation has 6 connections waiting for
// response headers, and a request queued behind them runs down its timeout
// before it is sent (a false indexer failure trips the circuit breaker).
// Starting the whole batch at once also let every name hit a failing indexer
// before its circuit breaker opened. The bound covers the background refreshes
// of stale cache entries too, which the cache starts in waitUntil.
const BATCH_CONCURRENCY = 6;
// A name not started within this budget gets a per-name error, so a slow
// outage degrades the batch instead of running it into the 30s route timeout
// (one 504 for every name). In an indexer outage a name already in flight
// needs ~10s more at most (two 2s attempts per indexer tier, then chain reads).
const BATCH_TIME_BUDGET_MS = 15_000;

function getMaxBatchNames(env: Env): number {
  // Invalid/garbage value → the default.
  const parsed = parseInt(env.MAX_BATCH_NAMES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BATCH_NAMES;
}

// A wrapper that runs at most `limit` calls at once; the others wait their turn.
// A finished call hands its slot straight to the next waiting one.
function concurrencyLimit(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// Calls fn on every item with at most `limit` calls in flight; results keep the
// input order.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Batch metadata endpoint
app.post("/batch-metadata", async (c) => {
  try {
    // A body that is not JSON (or is JSON null) is a client error, not a 500.
    const body = await c.req.json().catch(() => null);

    if (!body?.names || !Array.isArray(body.names)) {
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

    const maxNames = getMaxBatchNames(c.env);
    if (body.names.length > maxNames) {
      const errorResponse: ErrorResponse = {
        error: `Cannot process more than ${maxNames} names at once`,
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 400);
    }

    // Each name is echoed back in its result, so it must be a string: any other
    // JSON value would give the response a shape (and depth) the client chose.
    if (!body.names.every((name: unknown) => typeof name === 'string')) {
      const errorResponse: ErrorResponse = {
        error: "Every entry in 'names' must be a string",
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

    // Invalid names are answered without resolving them. Each distinct name is
    // resolved once, in its canonical form (the metadata cache key's), and every
    // entry for it shares the result while echoing the name as given.
    const names: string[] = body.names;
    // Validated as given and as resolved: lowercasing can lengthen a name.
    const isValid = (name: string) => validateEnsName(name) && validateEnsName(canonicalizeName(name));
    const distinct = [...new Set(names.filter(isValid).map(canonicalizeName))];

    type Outcome = { metadata: MetadataResponse } | { error?: string };
    const deadline = Date.now() + BATCH_TIME_BUDGET_MS;
    // Every resolution this batch starts, a cache miss's or the background
    // refresh of a stale entry, goes through one bound. (The per-name flow has
    // its own bound below and never waits on this one while holding it.)
    const resolveLimit = concurrencyLimit(BATCH_CONCURRENCY);
    const outcomes = await mapWithConcurrency(distinct, BATCH_CONCURRENCY, async (name): Promise<Outcome> => {
      if (Date.now() >= deadline) return { error: 'Batch time budget exceeded' };
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
          () => resolveLimit(() => metadataService.getMetadata(
            network,
            registryType as 'registry' | 'namewrapper',
            name,
            baseUrl,
            c.executionCtx,
          )),
        );
        return { metadata };
      } catch (err) {
        // An expiry verdict keeps its message; any other failure is reported per
        // entry below, as "Failed to resolve <entry>".
        return { error: err instanceof DomainExpiredError ? err.message : undefined };
      }
    });
    const outcomeByName = new Map(distinct.map((name, i) => [name, outcomes[i]]));

    const results = names.map((name) => {
      if (!isValid(name)) return { name, error: 'Invalid ENS name format' };
      const outcome = outcomeByName.get(canonicalizeName(name))!;
      return 'metadata' in outcome
        ? { name, metadata: outcome.metadata }
        : { name, error: outcome.error ?? `Failed to resolve ${name}` };
    });

    const batchResponse = {
      results,
      total: names.length,
      successful: results.filter(r => !('error' in r)).length,
      failed: results.filter(r => 'error' in r).length,
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
      if (edgeHit) return withMediaSecurityHeaders(edgeHit);

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
        if (cached) return withMediaSecurityHeaders(new Response(cached.body, cached));
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

      // Never rasterize an owner-chosen SVG avatar, or a raster one declaring
      // a huge pixel size, here: resvg's cost is unbounded by the file size
      // (see forRasterization). The shared (cached) card keeps the avatar for
      // the /image route, which the client renders.
      let svgForRasterize = imageService.forRasterization(result.svg, name, options.migrationStatus);

      // Square custom size: rewrite SVG width/height (viewBox stays fixed for auto-scaling)
      if (hasCustomSize && !isNonSquare) {
        svgForRasterize = svgForRasterize.replace(
          /<svg([^>]*)\bwidth="(\d+)"([^>]*)\bheight="(\d+)"/,
          `<svg$1width="${outputWidth}"$3height="${outputHeight}"`
        );
      }

      // Rasterize SVG to PNG
      const png = await rasterizeService.rasterize(svgForRasterize, c.env.ASSET_BUCKET, c.executionCtx);

      const pngResponse = new Response(png.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          ...MEDIA_SECURITY_HEADERS,
          'Content-Type': 'image/png',
          'Content-Length': png.byteLength.toString(),
          'X-Cache-Status': result.cacheStatus,
          'Cache-Control': cardCacheControl(result),
        },
      });

      // Store in CF edge cache with the shared capped TTL — caches.default is
      // per-colo and unpurgeable by the webhook, so the full softTtl (hours)
      // must never reach it (see EDGE_CACHE_MAX_AGE_SECS). A card whose avatar
      // lookup failed only briefly (see DEGRADED_CARD_MAX_AGE_SECS).
      edgeCachePut(c, pngResponse, result.avatarFailed ? DEGRADED_CARD_MAX_AGE_SECS : EDGE_CACHE_MAX_AGE_SECS);

      return pngResponse;
    } catch (error) {
      return httpError(c, error, "Failed to rasterize image");
    }
  }
);

// Webhook endpoint for cache invalidation + proactive warming. Sender-agnostic:
// any backend that knows a name changed can POST the EnsNameEvent contract here
// (see services/webhook.ts) — the indexer is just the current caller.
const handleWebhook = async (c: AppContext) => {
  // Clone before the service consumes the body, so we can read it for warming
  // without interfering with signature verification (which reads c.req.raw).
  const bodyClone = c.req.raw.clone();
  const { webhookService } = getServices(c.env, 'mainnet');

  try {
    const response = await webhookService.handleWebhook(c);

    // Only purge/warm when the webhook was accepted (validated + processed).
    if (response.status >= 200 && response.status < 300) {
      c.executionCtx.waitUntil((async () => {
        try {
          const payload = await bodyClone.json() as Partial<EnsNameEvent>;

          // Drop this isolate's cached expiry verdicts for the name on every
          // network, for any event type and whether the event carries the name
          // or only its namehash: an unregister ends a live verdict early. Only
          // services built in this isolate hold any; other isolates re-read
          // within EXPIRY_VERDICT_TTL_MS.
          for (const net of SUPPORTED_NETWORKS) {
            _fullServices.get(net)?.metadataService.evictExpiryVerdict({ name: payload?.name, namehash: payload?.namehash });
          }

          // Canonicalize like WebhookService does for its purges: the D1 name
          // column and warmed cache keys must never carry a raw-case variant.
          const name = payload?.name ? canonicalizeName(payload.name) : undefined;
          // An ignored event (a name this service never serves) has nothing to warm.
          if (!name || !validateEnsName(name)) return;

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
              const card = await imageCacheService.getImage(name, { name, migrationStatus }, c.executionCtx);
              console.log(
                card.avatarFailed
                  ? `[webhook] did not warm image cache for ${name} on ${net}: avatar lookup failed`
                  : `[webhook] warmed image cache for ${name} on ${net} (${migrationStatus})`,
              );
            } catch (err) {
              console.warn(`[webhook] skipped warm/persist for ${name} on ${net} (no D1 write):`, err);
            }
          }
        } catch (err) {
          console.warn('[webhook] cache warming failed:', err);
        }
      })());
    } else {
      // Rejected (e.g. 413): the clone is never read. A cloned body is a tee,
      // released only once both branches are cancelled, and the service has
      // read or cancelled its own, so cancel this one too.
      bodyClone.body?.cancel().catch(() => {});
    }

    return response;
  } catch (error) {
    bodyClone.body?.cancel().catch(() => {});
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
export function errorHandler(err: unknown, c: AppContext): Response | Promise<Response> {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error", timestamp: new Date().toISOString() }, 500);
}

app.onError(errorHandler);

// Cron trigger ([triggers] in wrangler.toml): the daily D1 retention run.
const scheduled: ExportedHandlerScheduledHandler<Env> = async (_controller, env) => {
  if (!env.DB) {
    console.warn('[d1-retention] no D1 binding, skipped');
    return;
  }
  await runD1Retention(env.DB, envSecsToMs('D1_RETENTION_SECS', env.D1_RETENTION_SECS, MIN_D1_RETENTION_SECS));
};

// The Worker's handlers: the Hono app (fetch, plus the request() helper the
// tests call) with the cron handler attached.
export default Object.assign(app, { scheduled });
