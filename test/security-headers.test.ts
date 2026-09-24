import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createMockEnv } from './mocks/hono-env';

// Every response carries nosniff, and every non-media response a CSP that
// allows nothing and cannot be framed (WEB-1548). A response that brings its
// own CSP keeps it.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The sandboxing CSP the media routes (avatar, header, card) set for themselves.
const MEDIA_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox";

const avatarMetaMock = vi.fn();

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

vi.mock('../src/services/avatar', () => ({
  AvatarService: class {
    getAvatarMeta(...args: unknown[]) { return avatarMetaMock(...args); }
    async getAvatarImage() { return { buffer: PNG, mimeType: 'image/png' }; }
    async getHeaderImage() { return null; }
    async getAvatarBase64() { return null; }
  },
}));

vi.mock('../src/services/image-cache', () => ({
  ImageCacheService: class {
    async getImage() {
      return {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        contentType: 'image/svg+xml',
        cacheStatus: 'miss',
        ttlConfig: { softTtl: 300, hardTtl: 600, r2MaxAge: 600 },
      };
    }
  },
}));

vi.mock('../src/services/metadata', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/metadata')>();
  const { UpstreamError } = await import('../src/services/errors');
  return {
    ...orig,
    MetadataService: class {
      async checkExpiry(name: string) {
        if (name === 'down.eth') throw new UpstreamError('indexer unreachable');
      }
      async resolveStatusForImage() { return 'unmigrated'; }
      async healthCheck() {
        return { indexerV2: 'ok', indexerV2Latency: 1, blockchain: { mainnet: 'ok', sepolia: 'ok' } };
      }
    },
  };
});

import app from '../src/index';
import { securityHeaders } from '../src/middleware/security-headers';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
// The webhook service is built once per isolate from the first request's env,
// so every request here carries a secret (unsigned webhooks → 401).
const env = () => ({ ...createMockEnv(), WEBHOOK_SECRET: 'test-secret' }) as unknown as Record<string, unknown>;
const req = (path: string, init?: RequestInit) => app.request(path, init, env(), ctx);

function stubEdgeCache(match: () => Promise<Response | undefined>) {
  vi.stubGlobal('caches', {
    default: { match: vi.fn(match), put: vi.fn(async () => {}), delete: vi.fn(async () => true) },
  });
}

function expectApiHeaders(res: Response) {
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(res.headers.get('X-Frame-Options')).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  avatarMetaMock.mockReset();
});

describe('security headers on API responses', () => {
  it.each([
    ['GET /', '/', undefined, 200],
    ['GET /health', '/health', undefined, 200],
    ['metadata upstream error', '/mainnet/registry/down.eth', undefined, 503],
    ['invalid network (validation middleware)', '/goerli/registry/nick.eth', undefined, 400],
    ['unknown route (notFound)', '/no-such-route', undefined, 404],
    ['avatar meta miss', '/mainnet/avatar/nick.eth/meta', undefined, 404],
    ['unsigned webhook', '/webhook', { method: 'POST', body: '{}' }, 401],
    ['CORS preflight', '/webhook', { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } }, 204],
  ] as const)('%s', async (_label, path, init, status) => {
    avatarMetaMock.mockResolvedValue(null);
    const res = await req(path, init as RequestInit | undefined);
    expect(res.status).toBe(status);
    expectApiHeaders(res);
  });

  it('onError: an unhandled error (500)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubEdgeCache(() => Promise.reject(new Error('cache unavailable')));
    const res = await req('/migration-status/nick.eth');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Internal Server Error' });
    expectApiHeaders(res);
  });

  it('onError: the timeout middleware 504 (HTTPException, text/plain)', async () => {
    vi.useFakeTimers();
    avatarMetaMock.mockReturnValue(new Promise(() => {}));
    const pending = req('/mainnet/avatar/nick.eth/meta');
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expectApiHeaders(res);
  });

  it('edge-cache hit rebuilt from caches.default', async () => {
    stubEdgeCache(async () => new Response('{"name":"nick.eth"}', {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    }));
    const res = await req('/migration-status/nick.eth');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'nick.eth' });
    expectApiHeaders(res);
  });
});

describe('media responses', () => {
  it('an edge-cache hit that carries its own CSP keeps it', async () => {
    stubEdgeCache(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      headers: { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': MEDIA_CSP },
    }));
    const res = await req('/mainnet/registry/nick.eth/image');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(MEDIA_CSP);
  });

  it.each([
    ['/mainnet/avatar/nick.eth', 'image/png'],
    ['/mainnet/registry/nick.eth/image', 'image/svg+xml'],
  ])('%s gets nosniff but stays embeddable', async (path, type) => {
    const res = await req(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(type);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy') ?? '').not.toContain('frame-ancestors');
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });
});

describe('securityHeaders middleware', () => {
  it('keeps a CSP the handler set', async () => {
    const mini = new Hono();
    mini.use('*', securityHeaders);
    mini.get('/', () => new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Security-Policy': "default-src 'self'" },
    }));
    const res = await mini.request('/');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('adds the headers to a response whose headers are immutable', async () => {
    const mini = new Hono();
    mini.use('*', securityHeaders);
    mini.get('/', () => Response.redirect('https://example.com/elsewhere', 302));
    const res = await mini.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://example.com/elsewhere');
    expectApiHeaders(res);
  });
});
