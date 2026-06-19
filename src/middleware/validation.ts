import { Context, Next } from 'hono';
import { validateEnsName } from '../utils/ens';

// Validate network parameter
export const validateNetwork = async (c: Context, next: Next) => {
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
export const validateEnsNameParam = async (c: Context, next: Next) => {
  const name = c.req.param('name');

  if (!name) {
    return c.json({
      error: "Name parameter is required",
      timestamp: new Date().toISOString()
    }, 400);
  }

  if (!validateEnsName(name)) {
    return c.json({
      error: "Invalid ENS name format",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Per-IP rate limiting backed by KV (fixed window).
//
// This is a best-effort, fail-open guard: KV is eventually consistent and not
// atomic, so counts can undercount briefly under burst — adequate to blunt
// abuse but NOT a hard quota. For strict limits in production prefer
// Cloudflare's native Rate Limiting binding / Durable Objects.
//
// Window is 60s. Limits are per route-class so the expensive endpoints
// (rasterize, batch, webhook) are tighter than plain metadata reads.
const RATE_WINDOW_SECS = 60;

interface RateBucket { name: string; limit: number; }

function getRateBucket(method: string, path: string): RateBucket | null {
  // Liveness/landing endpoints are never limited.
  if (path === '/health' || path === '/') return null;

  if (method === 'POST' && path === '/batch-metadata') return { name: 'batch', limit: 20 };
  if (path.startsWith('/webhook')) return { name: 'webhook', limit: 60 };
  if (path.endsWith('/rasterize')) return { name: 'rasterize', limit: 30 };
  if (path.endsWith('/image')) return { name: 'image', limit: 60 };
  return { name: 'default', limit: 120 };
}

function getClientIP(c: Context): string {
  // Trust ONLY CF-Connecting-IP (Cloudflare always sets it). X-Forwarded-For is
  // client-spoofable, which would let a caller rotate their rate-limit bucket.
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

export const rateLimiter = async (c: Context, next: Next) => {
  const kv = (c.env as any)?.METADATA_CACHE as KVNamespace | undefined;
  const disabled = String((c.env as any)?.RATE_LIMIT_DISABLED ?? '').toLowerCase() === 'true';

  const bucket = getRateBucket(c.req.method, c.req.path);
  if (disabled || !kv || !bucket) {
    return next();
  }

  const ip = getClientIP(c);
  const windowStart = Math.floor(Date.now() / 1000 / RATE_WINDOW_SECS) * RATE_WINDOW_SECS;
  const key = `rl:${bucket.name}:${ip}:${windowStart}`;

  try {
    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) || 0 : 0;

    if (count >= bucket.limit) {
      const retryAfter = windowStart + RATE_WINDOW_SECS - Math.floor(Date.now() / 1000);
      c.header('Retry-After', String(Math.max(1, retryAfter)));
      c.header('X-RateLimit-Limit', String(bucket.limit));
      c.header('X-RateLimit-Remaining', '0');
      return c.json({
        error: 'Rate limit exceeded. Please retry later.',
        timestamp: new Date().toISOString(),
      }, 429);
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
export const requestLogger = async (c: Context, next: Next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  console.log(`${method} ${path} - ${status} (${duration}ms)`);
};