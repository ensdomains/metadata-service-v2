import { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../index';
import { isResolvableEnsName } from '../utils/ens';

// Middlewares are typed as MiddlewareHandler<AppEnv>: `c.env` keeps the Env
// binding types, and the path type is `string` rather than the `any` of a bare
// Context, which (hono >= 4.12.5) would turn c.req.param() in the route
// handlers after them into `string | undefined`.

// Validate network parameter
export const validateNetwork: MiddlewareHandler<AppEnv> = async (c, next) => {
  const network = c.req.param('network');

  if (network && !['mainnet', 'sepolia'].includes(network)) {
    return c.json({
      error: "Invalid network. Must be 'mainnet' or 'sepolia'",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Validate ENS name parameter
export const validateEnsNameParam: MiddlewareHandler<AppEnv> = async (c, next) => {
  const name = c.req.param('name');

  if (!name) {
    return c.json({
      error: "Name parameter is required",
      timestamp: new Date().toISOString()
    }, 400);
  }

  // The shared name boundary (SEC-NAME-002): a name ENSIP-15 rejects, or one
  // over the caps as given or canonicalized, is a 400 before any expiry, cache,
  // avatar, indexer or resolver work.
  if (!isResolvableEnsName(name)) {
    return c.json({
      error: "Invalid ENS name format",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Per-IP rate limiting, one bucket per route class.
//
// In production each bucket is enforced by Cloudflare's Rate Limiting binding
// (wrangler.toml [[ratelimits]]: same limit, 60s period), keyed by client IP.
// The binding counts each request as it checks it, so a burst cannot slip
// through the way it does past a read-then-write counter. Its counters are kept
// per Cloudflare location (a client's traffic normally stays in one): it is an
// abuse guard, not an exact global quota.
//
// When a bucket's binding is absent (tests, or a deployment without the
// [[ratelimits]] config) the limiter falls back to a KV fixed-window counter.
// That fallback is best-effort: KV is eventually consistent and not atomic, so
// counts can undercount under burst — adequate to blunt abuse but NOT a quota.
//
// Both paths fail open: a limiter outage must not take down the API.
//
// Window is 60s. Limits are per route-class so the expensive endpoints
// (rasterize, batch) are tighter than plain metadata reads.
const RATE_WINDOW_SECS = 60;

// Limit per window and enforcing binding for each bucket. Keep in sync with
// the [[ratelimits]] entries in wrangler.toml (test/rate-limit.test.ts checks).
export const RATE_LIMIT_BUCKETS = {
  batch: { limit: 20, binding: 'RATE_LIMITER_BATCH' },
  // Far above the others: the webhook has one sender, and one transaction
  // (a bulk registration or renewal) or an indexer backfill emits a burst of
  // events from it; a 429 drops that event's cache purge and warm-up. This
  // limit applies before the signature is checked, so the body read for that
  // check is size-capped (MAX_WEBHOOK_BODY_BYTES in services/webhook.ts).
  webhook: { limit: 600, binding: 'RATE_LIMITER_WEBHOOK' },
  rasterize: { limit: 30, binding: 'RATE_LIMITER_RASTERIZE' },
  image: { limit: 60, binding: 'RATE_LIMITER_IMAGE' },
  default: { limit: 120, binding: 'RATE_LIMITER_DEFAULT' },
} as const;

type RateBucketName = keyof typeof RATE_LIMIT_BUCKETS;
interface RateBucket {
  name: RateBucketName;
  limit: number;
  binding: (typeof RATE_LIMIT_BUCKETS)[RateBucketName]['binding'];
}

function rateBucket(name: RateBucketName): RateBucket {
  return { name, ...RATE_LIMIT_BUCKETS[name] };
}

function getRateBucket(method: string, path: string): RateBucket | null {
  // Liveness/landing endpoints are never limited.
  if (path === '/health' || path === '/') return null;

  if (method === 'POST' && path === '/batch-metadata') return rateBucket('batch');
  if (path.startsWith('/webhook')) return rateBucket('webhook');
  if (path.endsWith('/rasterize')) return rateBucket('rasterize');
  if (path.endsWith('/image')) return rateBucket('image');
  return rateBucket('default');
}

function getClientIP(c: Context<AppEnv>): string {
  // Trust ONLY CF-Connecting-IP (Cloudflare always sets it). X-Forwarded-For is
  // client-spoofable, which would let a caller rotate their rate-limit bucket.
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

function rateLimited(c: Context<AppEnv>, bucket: RateBucket, retryAfterSecs: number): Response {
  c.header('Retry-After', String(Math.max(1, retryAfterSecs)));
  c.header('X-RateLimit-Limit', String(bucket.limit));
  c.header('X-RateLimit-Remaining', '0');
  return c.json({
    error: 'Rate limit exceeded. Please retry later.',
    timestamp: new Date().toISOString(),
  }, 429);
}

export const rateLimiter: MiddlewareHandler<AppEnv> = async (c, next) => {
  // `env` is undefined when the app runs without bindings (tests).
  const kv = c.env?.METADATA_CACHE;
  const disabled = String(c.env?.RATE_LIMIT_DISABLED ?? '').toLowerCase() === 'true';

  const bucket = getRateBucket(c.req.method, c.req.path);
  if (disabled || !bucket) {
    return next();
  }

  const ip = getClientIP(c);

  const limiter = c.env?.[bucket.binding];
  if (limiter) {
    let allowed = true;
    try {
      allowed = (await limiter.limit({ key: ip })).success;
    } catch (err) {
      console.warn('[rate-limit] binding check failed, allowing request:', err);
    }
    // The binding reports neither the window position nor the remaining
    // count: ask for a full period (an upper bound) and send the limit only.
    if (!allowed) return rateLimited(c, bucket, RATE_WINDOW_SECS);
    c.header('X-RateLimit-Limit', String(bucket.limit));
    return next();
  }

  if (!kv) {
    return next();
  }

  const windowStart = Math.floor(Date.now() / 1000 / RATE_WINDOW_SECS) * RATE_WINDOW_SECS;
  const key = `rl:${bucket.name}:${ip}:${windowStart}`;

  try {
    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) || 0 : 0;

    if (count >= bucket.limit) {
      return rateLimited(c, bucket, windowStart + RATE_WINDOW_SECS - Math.floor(Date.now() / 1000));
    }

    // Increment for this window. expirationTtl auto-expires the counter so we
    // never accumulate stale keys. (Not atomic — acceptable for a soft guard.)
    c.executionCtx?.waitUntil(
      kv.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_SECS + 5 }).catch(() => {}),
    );
    c.header('X-RateLimit-Limit', String(bucket.limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, bucket.limit - count - 1)));
  } catch (err) {
    // Fail open — a limiter outage must not take down the API.
    console.warn('[rate-limit] check failed, allowing request:', err);
  }

  await next();
};

// Request logging with performance metrics
export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  console.log(`${method} ${path} - ${status} (${duration}ms)`);
};