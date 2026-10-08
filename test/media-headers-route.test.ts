import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Every route that returns attacker-influenced media must pin the browser's
// interpretation (WEB-1549): no MIME sniffing, and a sandboxing CSP if the
// document is opened directly.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

vi.mock('../src/services/avatar', () => ({
  AvatarService: class {
    async getAvatarImage() { return { buffer: PNG, mimeType: 'image/png' }; }
    async getHeaderImage() { return { buffer: PNG, mimeType: 'image/png' }; }
    async getAvatarMeta() { return null; }
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
  return {
    ...orig,
    MetadataService: class {
      async checkExpiry() {}
      async resolveStatusForImage() { return 'unmigrated'; }
    },
  };
});

import app from '../src/index';
import { MEDIA_VIEW_CONTENT_SECURITY_POLICY } from '../src/middleware/security-headers';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

describe('media served from the edge cache carries nosniff and a sandboxing CSP', () => {
  // caches.default is keyed by URL and holds an entry for up to
  // EDGE_CACHE_MAX_AGE_SECS, so right after this deploy a colo can still hold a
  // card stored before it: no security headers, and markup the old card
  // builder let an avatar's Content-Type inject.
  const PRE_FIX_CARD = '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png" onload="alert(1)"/><script>alert(2)</script></svg>';

  function edgeHolding(entries: Record<string, Response>) {
    const cache = {
      match: vi.fn(async (key: RequestInfo | URL) => {
        const url = key instanceof Request ? key.url : String(key);
        return entries[url]?.clone();
      }),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    };
    vi.stubGlobal('caches', { default: cache });
    return cache;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ['/mainnet/registry/nick.eth/image', 'image/svg+xml', PRE_FIX_CARD],
    ['/mainnet/registry/nick.eth/rasterize', 'image/png', 'PNG'],
  ])('%s: an entry stored without the headers is served with them', async (path, type, body) => {
    const cache = edgeHolding({
      [`http://localhost${path}`]: new Response(body, {
        headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' },
      }),
    });

    const res = await req(path);

    expect(cache.match).toHaveBeenCalled();
    expect(await res.text()).toBe(body); // the edge entry, not a fresh render
    expect(res.headers.get('Content-Type')).toBe(type);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
  });
});

describe('media responses carry nosniff and a sandboxing CSP', () => {
  it.each([
    ['/mainnet/avatar/nick.eth', 'image/png'],
    ['/mainnet/header/nick.eth', 'image/png'],
    ['/mainnet/registry/nick.eth/image', 'image/svg+xml'],
    ['/mainnet/registry/nick.eth/rasterize', 'image/png'],
  ])('%s', async (path, type) => {
    const res = await req(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(type);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
  });
});

describe('media opened in a browser tab is shown on a page that draws it with <img>', () => {
  const visit = (path: string, dest?: string) =>
    app.request(
      path,
      dest ? { headers: { 'Sec-Fetch-Dest': dest } } : undefined,
      createMockEnv() as unknown as Record<string, unknown>,
      ctx,
    );

  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    '/mainnet/avatar/nick.eth',
    '/mainnet/header/nick.eth',
    '/mainnet/registry/nick.eth/image',
    '/mainnet/registry/nick.eth/rasterize',
  ])('%s', async (path) => {
    const res = await visit(path, 'document');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toBe(MEDIA_VIEW_CONTENT_SECURITY_POLICY);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Vary')).toBe('Sec-Fetch-Dest');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain(`<img src="${path}" alt="${path}">`);
    expect(html).not.toContain('<svg'); // the media itself is never in the page
  });

  it('keeps the query string, escaped', async () => {
    const html = await (await visit('/mainnet/registry/nick.eth/image?w=500&h=500', 'document')).text();
    expect(html).toContain('<img src="/mainnet/registry/nick.eth/image?w=500&#38;h=500"');
  });

  it('titles the page with the decoded path', async () => {
    const html = await (await visit('/mainnet/avatar/%F0%9F%A6%8A.eth', 'document')).text();
    expect(html).toContain('<title>/mainnet/avatar/\u{1F98A}.eth</title>');
    expect(html).toContain('<img src="/mainnet/avatar/%F0%9F%A6%8A.eth"');
  });

  it.each(['image', 'iframe', 'embed', 'empty', undefined])('Sec-Fetch-Dest: %s gets the media itself', async (dest) => {
    const res = await visit('/mainnet/registry/nick.eth/image', dest);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Vary')).toContain('Sec-Fetch-Dest');
  });

  it('never puts the page in the edge cache', async () => {
    const put = vi.fn(async () => {});
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put, delete: vi.fn(async () => true) } });
    await visit('/mainnet/registry/nick.eth/image', 'document');
    expect(put).toHaveBeenCalled();
    for (const [, res] of put.mock.calls as unknown as [unknown, Response][]) {
      expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    }
  });

  it('leaves a response that is not media as it is', async () => {
    const res = await visit('/mainnet/avatar/nick.eth/meta', 'document');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
  });
});
