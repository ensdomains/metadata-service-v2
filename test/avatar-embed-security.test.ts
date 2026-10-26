import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// The layout composer interpolates `backgroundImageUrl` into
// `<image href="...">` without escaping; capture what we hand it.
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn().mockResolvedValue(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
  initializeFont: vi.fn(),
}));

import { createDynamicSVGImage } from 'adaptive-layout-composer';
import { ImageGenerationService } from '../src/services/image';
import { ImageCacheService } from '../src/services/image-cache';
import { StorageManager } from '../src/utils/storage';
import type { AvatarService } from '../src/services/avatar';
import { createMockKV, createMockR2 } from './mocks/hono-env';

// Security regression suite for the NFT card SVG (WEB-1549): the avatar's MIME
// type used to be interpolated raw into `data:{type};base64,...`, so a crafted
// remote Content-Type broke out of the href attribute and injected markup into
// a card that is cached in KV and R2 and served as image/svg+xml.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const INJECTING_TYPE = 'image/png" onload="alert(1)" x="';
const composer = createDynamicSVGImage as unknown as Mock;

function lastComposerOptions(): { backgroundImageUrl: string | null; backgroundColor: string } {
  return composer.mock.calls.at(-1)![0];
}

beforeEach(() => {
  composer.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('ImageGenerationService only embeds allowlisted avatar types', () => {
  const svc = new ImageGenerationService();

  it('drops an avatar whose type would break out of the href attribute', async () => {
    await svc.generateDomainImage({ name: 'evil.eth', avatarBase64: PNG.toString('base64'), avatarMimeType: INJECTING_TYPE });
    const opts = lastComposerOptions();
    expect(opts.backgroundImageUrl).toBeNull();
    expect(opts.backgroundColor).not.toBe('transparent');
  });

  it('drops an avatar whose payload is not plain base64', async () => {
    await svc.generateDomainImage({ name: 'evil.eth', avatarBase64: 'AAAA" onload="alert(1)', avatarMimeType: 'image/png' });
    expect(lastComposerOptions().backgroundImageUrl).toBeNull();
  });

  it('drops a non-image type even without markup characters', async () => {
    await svc.generateDomainImage({ name: 'evil.eth', avatarBase64: PNG.toString('base64'), avatarMimeType: 'text/html' });
    expect(lastComposerOptions().backgroundImageUrl).toBeNull();
  });

  it('embeds a valid avatar unchanged', async () => {
    const b64 = PNG.toString('base64');
    await svc.generateDomainImage({ name: 'ok.eth', avatarBase64: b64, avatarMimeType: 'image/png' });
    const opts = lastComposerOptions();
    expect(opts.backgroundImageUrl).toBe(`data:image/png;base64,${b64}`);
    expect(opts.backgroundColor).toBe('transparent');
  });
});

describe('ImageCacheService re-classifies avatars cached in R2 before the fix', () => {
  function setup(r2Avatar: { bytes: Buffer; contentType: string }) {
    const r2 = createMockR2();
    (r2.get as Mock).mockImplementation(async (key: string) =>
      key.startsWith('avatars/')
        ? {
            arrayBuffer: async () => r2Avatar.bytes.buffer.slice(r2Avatar.bytes.byteOffset, r2Avatar.bytes.byteOffset + r2Avatar.bytes.byteLength),
            httpMetadata: { contentType: r2Avatar.contentType },
          }
        : null,
    );
    const avatarService = { getAvatarImage: vi.fn().mockResolvedValue(null), getTextRecord: vi.fn().mockResolvedValue(null) } as unknown as AvatarService;
    const cache = new ImageCacheService(createMockKV(), new StorageManager(r2), new ImageGenerationService(), avatarService, 'mainnet');
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    return { cache, ctx, avatarService };
  }

  it('a poisoned object (non-image bytes + injecting type) is not embedded and is re-resolved', async () => {
    const { cache, ctx, avatarService } = setup({ bytes: Buffer.from([1, 2, 3, 4]), contentType: INJECTING_TYPE });
    await cache.getImage('evil.eth', { name: 'evil.eth' }, ctx);
    expect(lastComposerOptions().backgroundImageUrl).toBeNull();
    expect(avatarService.getAvatarImage).toHaveBeenCalledWith('evil.eth');
  });

  it('real image bytes stored with a wrong type are embedded with their own type', async () => {
    const { cache, ctx, avatarService } = setup({ bytes: PNG, contentType: 'text/html' });
    await cache.getImage('ok.eth', { name: 'ok.eth' }, ctx);
    expect(lastComposerOptions().backgroundImageUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(avatarService.getAvatarImage).not.toHaveBeenCalled();
  });
});

describe('card cache version', () => {
  it('keys cards by version so cards rendered before this fix are never served, and keeps the per-name prefix', async () => {
    const kv = createMockKV();
    const cache = new ImageCacheService(kv, new StorageManager(createMockR2()), new ImageGenerationService(), { getAvatarImage: vi.fn().mockResolvedValue(null), getTextRecord: vi.fn().mockResolvedValue(null) } as unknown as AvatarService, 'mainnet');
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    await cache.getImage('Nick.eth', { name: 'Nick.eth' }, ctx);
    const key = (kv.get as Mock).mock.calls[0][0] as string;
    expect(key.startsWith('svg:nick.eth:')).toBe(true); // webhook invalidation prefix
    expect(key.endsWith(':v4')).toBe(true);
  });
});
