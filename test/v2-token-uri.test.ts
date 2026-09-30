import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { NotFoundError } from '../src/services/errors';

// A v2 registry's token URI is {PREFIX}{registry}{AFTER_REGISTRY}{tokenId}
// {AFTER_TOKEN}, and the renderer may set AFTER_TOKEN to ".json". The metadata
// route takes that form too; the image and rasterize URLs are this service's
// own, so they are left as they are.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

const REGISTRY = '0x6f076422511cf206088e710de61abbe5fae0e516';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('metadata route: a token id ending in .json', () => {
  it('resolves the token id without the suffix', async () => {
    const resolve = vi.spyOn(MetadataService.prototype, 'resolveTokenId').mockRejectedValue(new NotFoundError('no such token'));

    const res = await req(`/sepolia/${REGISTRY}/12345.json`);

    expect(res.status).toBe(404);
    expect(resolve).toHaveBeenCalledWith('sepolia', REGISTRY, '12345');
  });

  it('resolves a 0x hex token id without the suffix', async () => {
    const resolve = vi.spyOn(MetadataService.prototype, 'resolveTokenId').mockRejectedValue(new NotFoundError('no such token'));

    await req(`/sepolia/${REGISTRY}/0xabc.json`);

    expect(resolve).toHaveBeenCalledWith('sepolia', REGISTRY, '0xabc');
  });

  it.each(['/image', '/rasterize'])('leaves the %s route as it is', async (suffix) => {
    const resolve = vi.spyOn(MetadataService.prototype, 'resolveTokenId').mockRejectedValue(new NotFoundError('no such token'));

    await req(`/sepolia/${REGISTRY}/12345.json${suffix}`);

    expect(resolve).toHaveBeenCalledWith('sepolia', REGISTRY, '12345.json');
  });
});
