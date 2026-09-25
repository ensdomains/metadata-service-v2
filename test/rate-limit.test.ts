import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { Hono } from 'hono';
import { unstable_readConfig } from 'wrangler';
import { rateLimiter, RATE_LIMIT_BUCKETS } from '../src/middleware/validation';
import type { Env } from '../src/index';

// WEB-1552: each rate-limit bucket is enforced by its own Cloudflare Rate
// Limiting binding, keyed by CF-Connecting-IP. The KV counter is only the
// fallback for a bucket whose binding is absent.

const IP = '203.0.113.7';

// The deployed config, read with wrangler's own parser.
const readWranglerConfig = () =>
  unstable_readConfig({ config: path.resolve(__dirname, '../wrangler.toml') }, { hideWarnings: true });

function makeApp() {
  const app = new Hono();
  app.use('*', rateLimiter);
  app.all('*', (c) => c.text('ok'));
  return app;
}

// Rate Limiting binding double: allows `limit` calls per key.
function fakeBinding(limit: number) {
  const counts = new Map<string, number>();
  return {
    limit: vi.fn(async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    }),
  };
}

function memoryKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
  };
}

function send(
  app: Hono,
  env: Record<string, unknown>,
  url: string,
  opts: { method?: string; ip?: string; headers?: Record<string, string> } = {},
) {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
  const headers = { 'CF-Connecting-IP': opts.ip ?? IP, ...opts.headers };
  return app.request(url, { method: opts.method ?? 'GET', headers }, env, ctx as any);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rateLimiter — Rate Limiting binding', () => {
  it('enforces the default bucket through its binding, keyed by CF-Connecting-IP only', async () => {
    const app = makeApp();
    const binding = fakeBinding(2);
    const kv = memoryKv();
    const env = { RATE_LIMITER_DEFAULT: binding, METADATA_CACHE: kv };

    const ok = await send(app, env, '/mainnet/registry/fox.eth');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-RateLimit-Limit')).toBe('120');
    // A spoofed X-Forwarded-For does not move the caller to another key.
    expect((await send(app, env, '/mainnet/registry/fox.eth', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status).toBe(200);

    const denied = await send(app, env, '/mainnet/registry/fox.eth');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBe('60');
    expect(denied.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(await denied.json()).toMatchObject({ error: 'Rate limit exceeded. Please retry later.' });

    expect(binding.limit).toHaveBeenCalledTimes(3);
    expect(binding.limit).toHaveBeenCalledWith({ key: IP });
    // Another client has its own count.
    expect((await send(app, env, '/mainnet/registry/fox.eth', { ip: '203.0.113.8' })).status).toBe(200);
    // With the binding present the KV counter is not used at all.
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('limits POST /batch-metadata through the stricter batch binding, independently of the default bucket', async () => {
    const app = makeApp();
    const batch = fakeBinding(0); // exhausted
    const dflt = fakeBinding(100);
    const env = { RATE_LIMITER_BATCH: batch, RATE_LIMITER_DEFAULT: dflt, METADATA_CACHE: memoryKv() };

    const denied = await send(app, env, '/batch-metadata', { method: 'POST' });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('X-RateLimit-Limit')).toBe('20');

    // The same client can still read metadata: the default bucket is separate.
    const ok = await send(app, env, '/mainnet/registry/fox.eth');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-RateLimit-Limit')).toBe('120');

    expect(batch.limit).toHaveBeenCalledTimes(1);
    expect(dflt.limit).toHaveBeenCalledTimes(1);
  });

  it('checks each route class against its own binding, and never limits the liveness routes', async () => {
    const app = makeApp();
    const bindings = Object.fromEntries(
      Object.values(RATE_LIMIT_BUCKETS).map(({ binding }) => [binding, fakeBinding(100)]),
    );
    const env = { ...bindings, METADATA_CACHE: memoryKv() };
    const cases: Array<[string, string, string]> = [
      ['POST', '/batch-metadata', 'RATE_LIMITER_BATCH'],
      ['POST', '/webhook', 'RATE_LIMITER_WEBHOOK'],
      ['GET', '/mainnet/0xabc/1/rasterize', 'RATE_LIMITER_RASTERIZE'],
      ['GET', '/mainnet/0xabc/1/image', 'RATE_LIMITER_IMAGE'],
      ['GET', '/mainnet/registry/fox.eth', 'RATE_LIMITER_DEFAULT'],
      ['GET', '/batch-metadata', 'RATE_LIMITER_DEFAULT'],
    ];

    for (const [method, url, expected] of cases) {
      for (const b of Object.values(bindings)) b.limit.mockClear();
      expect((await send(app, env, url, { method })).status).toBe(200);
      for (const [name, b] of Object.entries(bindings)) {
        expect(b.limit, `${method} ${url} → ${name}`).toHaveBeenCalledTimes(name === expected ? 1 : 0);
      }
    }

    for (const b of Object.values(bindings)) b.limit.mockClear();
    expect((await send(app, env, '/health')).status).toBe(200);
    expect((await send(app, env, '/')).status).toBe(200);
    for (const b of Object.values(bindings)) expect(b.limit).not.toHaveBeenCalled();
  });

  it('fails open when the binding errors, without falling back to KV', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = makeApp();
    const binding = { limit: vi.fn().mockRejectedValue(new Error('rate limiter unavailable')) };
    const kv = memoryKv();

    const res = await send(app, { RATE_LIMITER_DEFAULT: binding, METADATA_CACHE: kv }, '/mainnet/registry/fox.eth');
    expect(res.status).toBe(200);
    expect(binding.limit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[rate-limit] binding check failed, allowing request:', expect.any(Error));
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('RATE_LIMIT_DISABLED=true bypasses the binding as it does the KV counter', async () => {
    const app = makeApp();
    const binding = fakeBinding(0);
    const env = { RATE_LIMITER_DEFAULT: binding, METADATA_CACHE: memoryKv() };

    expect((await send(app, { ...env, RATE_LIMIT_DISABLED: 'true' }, '/mainnet/registry/fox.eth')).status).toBe(200);
    expect(binding.limit).not.toHaveBeenCalled();

    expect((await send(app, env, '/mainnet/registry/fox.eth')).status).toBe(429);
    expect(binding.limit).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimiter — KV fallback for a bucket without a binding', () => {
  it('counts in KV exactly as before for that bucket, while a bucket with a binding does not touch KV', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:15Z'));
    const app = makeApp();
    const windowStart = Math.floor(Date.now() / 1000 / 60) * 60;
    const key = `rl:default:${IP}:${windowStart}`;
    const kv = memoryKv({ [key]: '5' });
    const batch = fakeBinding(100);
    const env = { RATE_LIMITER_BATCH: batch, METADATA_CACHE: kv };

    const ok = await send(app, env, '/mainnet/registry/fox.eth');
    expect(ok.status).toBe(200);
    expect(kv.get).toHaveBeenCalledWith(key);
    expect(kv.put).toHaveBeenCalledWith(key, '6', { expirationTtl: 65 });
    expect(ok.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(ok.headers.get('X-RateLimit-Remaining')).toBe('114');

    kv.get.mockResolvedValueOnce('120');
    const denied = await send(app, env, '/mainnet/registry/fox.eth');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(denied.headers.get('Retry-After')).toBe('45'); // to the end of the fixed window

    // The batch bucket has its binding: it is counted there, not in KV.
    kv.get.mockClear();
    kv.put.mockClear();
    expect((await send(app, env, '/batch-metadata', { method: 'POST' })).status).toBe(200);
    expect(batch.limit).toHaveBeenCalledWith({ key: IP });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe('rateLimiter — webhook bucket', () => {
  // One transaction (a bulk registration or renewal) or an indexer backfill
  // emits a burst of events from the one sender; a 429 drops that event's
  // cache purge and warm-up.
  const postWebhooks = async (app: Hono, env: Record<string, unknown>, n: number) => {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await send(app, env, '/webhook', { method: 'POST' })).status);
    return statuses;
  };

  it('lets one sender post 600 events a minute through the binding, and limits the 601st', async () => {
    const app = makeApp();
    // The binding as deployed: its limit comes from wrangler.toml.
    const declared = readWranglerConfig().ratelimits.find((r) => r.name === 'RATE_LIMITER_WEBHOOK');
    const binding = fakeBinding(declared!.simple.limit);
    const env = { RATE_LIMITER_WEBHOOK: binding, METADATA_CACHE: memoryKv() };

    expect(new Set(await postWebhooks(app, env, 600))).toEqual(new Set([200]));
    const denied = await send(app, env, '/webhook', { method: 'POST' });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('X-RateLimit-Limit')).toBe('600');
    expect(binding.limit).toHaveBeenCalledTimes(601);
  });

  it('uses the same limit on the KV fallback path', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:15Z'));
    const app = makeApp();
    const env = { METADATA_CACHE: memoryKv() };

    expect(new Set(await postWebhooks(app, env, 600))).toEqual(new Set([200]));
    const denied = await send(app, env, '/webhook', { method: 'POST' });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('X-RateLimit-Limit')).toBe('600');
  });
});

describe('wrangler.toml [[ratelimits]]', () => {
  it('declares one binding per bucket, with the same limit and a 60 s period', () => {
    const config = readWranglerConfig();
    const buckets = Object.values(RATE_LIMIT_BUCKETS);

    expect(config.ratelimits).toHaveLength(buckets.length);
    for (const { binding, limit } of buckets) {
      const declared = config.ratelimits.find((r) => r.name === binding);
      expect(declared, binding).toBeDefined();
      expect(declared!.simple).toEqual({ limit, period: 60 });
    }
    const ids = config.ratelimits.map((r) => r.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[1-9]\d*$/);
  });
});

// Compile-time check (tsc): every bucket's binding is declared on Env.
type BucketBinding = (typeof RATE_LIMIT_BUCKETS)[keyof typeof RATE_LIMIT_BUCKETS]['binding'];
export type EnvDeclaresBucketBindings = Pick<Env, BucketBinding>;
