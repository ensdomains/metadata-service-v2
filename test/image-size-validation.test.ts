import { describe, it, expect, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Regression (WEB-1551): `?w=` / `?h=` that are not numbers parse to NaN, and
// every range comparison against NaN is false, so validation passed. The card
// then rendered with width="NaN" and the image cache stored it under the default
// 518x518 key (NaN || 518), so one request replaced the default image for every
// viewer of that name.

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
      async resolveStatusForImage() { return 'unmigrated'; }
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

  it('a valid size still renders', async () => {
    getImage.mockClear();
    const res = await req('/mainnet/registry/nick.eth/image?w=300&h=300');
    expect(res.status).toBe(200);
    expect(getImage).toHaveBeenCalledTimes(1);
  });
});
