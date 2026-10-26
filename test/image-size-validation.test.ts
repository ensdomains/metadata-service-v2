import { describe, it, expect, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Regression (WEB-1551): `?w=` / `?h=` that are not numbers parse to NaN, and
// every range comparison against NaN is false, so validation passed. The card
// then rendered with width="NaN" and the image cache stored it under the default
// 518x518 key (NaN || 518), so one request replaced the default image for every
// viewer of that name.

const resolveStatusForImage = vi.fn(async () => 'unmigrated');

const getImage = vi.fn(async () => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  contentType: 'image/svg+xml',
  cacheStatus: 'miss',
  ttlConfig: { softTtl: 300, hardTtl: 600, r2MaxAge: 600 },
}));

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));
vi.mock('../src/services/image-cache', () => ({
  ImageCacheService: class {
    getImage = getImage;
  },
}));
vi.mock('../src/services/metadata', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/metadata')>();
  return {
    ...orig,
    MetadataService: class {
      async checkExpiry() {}
      resolveStatusForImage = resolveStatusForImage;
    },
  };
});

import app from '../src/index';
import { ImageGenerationService } from '../src/services/image';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

describe('validateOptions rejects non-integer sizes', () => {
  const svc = new ImageGenerationService();
  it.each([
    [NaN, 518],
    [518, NaN],
    [Infinity, 518],
    [150.5, 518],
  ])('width=%s height=%s', (width, height) => {
    expect(svc.validateOptions({ name: 'a.eth', size: { width, height } }).valid).toBe(false);
  });

  it('still accepts in-range integers', () => {
    expect(svc.validateOptions({ name: 'a.eth', size: { width: 300, height: 1000 } }).valid).toBe(true);
  });
});

describe('GET /:network/registry/:name/image with a non-numeric size', () => {
  it.each(['?w=abc&h=abc', '?w=abc&h=300', '?w=300&h=x'])('%s → 400 and nothing is rendered or cached', async (query) => {
    getImage.mockClear();
    const res = await req(`/mainnet/registry/nick.eth/image${query}`);
    expect(res.status).toBe(400);
    expect(getImage).not.toHaveBeenCalled();
  });

  // W8-ROUTES-002: parseInt reads a numeric prefix, so these used to render and
  // cache a card. The whole value must be a decimal integer.
  it.each([
    '?w=100a&h=100',
    '?w=100&h=100a',
    '?w=300.0&h=300',
    '?w=%20300&h=300',
    '?w=%2B300&h=300',
    '?w=300&h=0x12c',
    '?w=3e2&h=300',
  ])('%s → 400 before the status lookup, rendering or caching', async (query) => {
    getImage.mockClear();
    resolveStatusForImage.mockClear();
    const res = await req(`/mainnet/registry/nick.eth/image${query}`);
    expect(res.status).toBe(400);
    expect(resolveStatusForImage).not.toHaveBeenCalled();
    expect(getImage).not.toHaveBeenCalled();
  });

  it.each(['?w=99&h=300', '?w=300&h=2001'])('%s → 400: the 100–2000 range still applies', async (query) => {
    getImage.mockClear();
    const res = await req(`/mainnet/registry/nick.eth/image${query}`);
    expect(res.status).toBe(400);
    expect(getImage).not.toHaveBeenCalled();
  });

  it.each(['?w=100&h=100', '?w=2000&h=2000', '?w=0300&h=300'])('%s still renders', async (query) => {
    getImage.mockClear();
    const res = await req(`/mainnet/registry/nick.eth/image${query}`);
    expect(res.status).toBe(200);
    expect(getImage).toHaveBeenCalledTimes(1);
  });

  it('a valid size still renders', async () => {
    getImage.mockClear();
    const res = await req('/mainnet/registry/nick.eth/image?w=300&h=300');
    expect(res.status).toBe(200);
    expect(getImage).toHaveBeenCalledTimes(1);
  });
});
