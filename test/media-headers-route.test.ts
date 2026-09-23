import { describe, it, expect, vi } from 'vitest';
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

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

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
