import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ImageCacheService } from '../src/services/image-cache';
import { StorageManager } from '../src/utils/storage';
import { ImageGenerationService } from '../src/services/image';
import { AvatarService } from '../src/services/avatar';
import { sepolia } from 'viem/chains';
import { createMockKV, createMockR2 } from './mocks/hono-env';

// Mock adaptive-layout-composer
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn().mockResolvedValue(new TextEncoder().encode('<svg>Mock SVG</svg>')),
}));

// Mock ENS utilities
vi.mock('../src/utils/ens', () => ({
  getCharacterSet: vi.fn().mockReturnValue('latin'),
  getSegmentLength: vi.fn().mockReturnValue({ type: 'short', length: 4 }),
  validateEnsName: vi.fn().mockReturnValue(true),
  canonicalizeName: (n: string) => n.toLowerCase(),
}));

// Mock AvatarService
vi.mock('../src/services/avatar', () => ({
  AvatarService: vi.fn().mockImplementation(() => ({
    getAvatarImage: vi.fn().mockResolvedValue(null),
    getAvatarBase64: vi.fn().mockResolvedValue(null),
  })),
}));

describe('ImageCacheService', () => {
  let svgCacheKv: KVNamespace;
  let r2Bucket: R2Bucket;
  let storage: StorageManager;
  let imageService: ImageGenerationService;
  let avatarService: AvatarService;
  let imageCacheService: ImageCacheService;
  let executionCtx: ExecutionContext;
  let waitUntilPromises: Promise<unknown>[];

  beforeEach(() => {
    svgCacheKv = createMockKV();
    r2Bucket = createMockR2();
    storage = new StorageManager(r2Bucket);
    avatarService = new AvatarService('https://mainnet.test.rpc', sepolia);
    imageService = new ImageGenerationService(avatarService);
    imageCacheService = new ImageCacheService(svgCacheKv, storage, imageService, avatarService, 'sepolia');

    waitUntilPromises = [];
    executionCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
  });

  const defaultOptions = {
    name: 'nick.eth',
    migrationStatus: 'unmigrated' as const,
  };

  describe('L1 fresh hit', () => {
    it('should return immediately from KV without touching R2 or origin', async () => {
      const entry = JSON.stringify({
        svg: '<svg>Cached</svg>',
        createdAt: Date.now(), // fresh
        softTtl: 300,
        avatarHash: '',
        migrationStatus: 'unmigrated',
      });
      (svgCacheKv.get as Mock).mockResolvedValue(entry);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBe('<svg>Cached</svg>');
      expect(result.cacheStatus).toBe('hit');
      expect(r2Bucket.get).not.toHaveBeenCalled();
      expect(executionCtx.waitUntil).not.toHaveBeenCalled();
    });
  });

  describe('L1 stale hit', () => {
    it('should return stale data and trigger background revalidation', async () => {
      const entry = JSON.stringify({
        svg: '<svg>Stale</svg>',
        createdAt: Date.now() - 400_000, // 400s old, past 300s softTtl
        softTtl: 300,
        avatarHash: '',
        migrationStatus: 'unmigrated',
      });
      (svgCacheKv.get as Mock).mockResolvedValue(entry);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBe('<svg>Stale</svg>');
      expect(result.cacheStatus).toBe('stale');
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);

      // Wait for background revalidation to complete
      await Promise.all(waitUntilPromises);
    });
  });

  describe('L1 miss + L2 hit', () => {
    it('should return from R2 and backfill KV in background', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null); // L1 miss
      vi.mocked(r2Bucket.get).mockResolvedValue({
        text: vi.fn().mockResolvedValue('<svg>R2 SVG</svg>'),
        arrayBuffer: vi.fn(),
        body: null,
        bodyUsed: false,
        blob: vi.fn(),
        json: vi.fn(),
      } as unknown as R2ObjectBody);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBe('<svg>R2 SVG</svg>');
      expect(result.cacheStatus).toBe('stale');
      // Should backfill KV
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntilPromises);
      expect(svgCacheKv.put).toHaveBeenCalled();
    });
  });

  describe('Full miss (L3 origin)', () => {
    it('should generate from origin and write back to all tiers', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null); // L1 miss
      vi.mocked(r2Bucket.get).mockResolvedValue(null); // L2 miss

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBeDefined();
      expect(result.cacheStatus).toBe('miss');
      // Should write back to KV + R2
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntilPromises);
      expect(svgCacheKv.put).toHaveBeenCalled();
      expect(r2Bucket.put).toHaveBeenCalled();
    });
  });

  describe('Avatar R2 cache hit', () => {
    it('should use R2 avatar instead of RPC resolution', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      // First r2Bucket.get for SVG returns null, second for avatar returns data
      vi.mocked(r2Bucket.get)
        .mockResolvedValueOnce(null) // SVG miss
        .mockResolvedValueOnce({
          // A real PNG signature: cached avatars are re-classified by their bytes.
          arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer),
          text: vi.fn(),
          body: null,
          bodyUsed: false,
        } as unknown as R2ObjectBody);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.cacheStatus).toBe('miss');
      // Avatar RPC should NOT be called because R2 avatar was found
      expect(avatarService.getAvatarImage).not.toHaveBeenCalled();
    });
  });

  describe('Write-back failure', () => {
    it('should not affect response when KV write fails', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockResolvedValue(null);
      vi.mocked(svgCacheKv.put).mockRejectedValue(new Error('KV write error'));

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBeDefined();
      expect(result.cacheStatus).toBe('miss');
      // Background write-back fails silently
      await Promise.all(waitUntilPromises);
    });
  });

  describe('KV read failure', () => {
    it('should fall through to R2 when KV read fails', async () => {
      (svgCacheKv.get as Mock).mockRejectedValue(new Error('KV read error'));
      vi.mocked(r2Bucket.get).mockResolvedValue({
        text: vi.fn().mockResolvedValue('<svg>R2 Fallback</svg>'),
        arrayBuffer: vi.fn(),
        body: null,
        bodyUsed: false,
      } as unknown as R2ObjectBody);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBe('<svg>R2 Fallback</svg>');
    });
  });

  describe('Corrupted KV JSON', () => {
    it('should fall through when KV entry has invalid JSON', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue('not valid json{{{');
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      // Falls through to origin
      expect(result.cacheStatus).toBe('miss');
    });
  });

  describe('invalidate', () => {
    it('should clear KV and R2 entries for a domain', async () => {
      vi.mocked(svgCacheKv.list).mockResolvedValue({
        keys: [
          { name: 'svg:nick.eth:unmigrated:classic:gradient:518:518' },
          { name: 'svg:nick.eth:migrated:modern:solid:518:518' },
        ],
        list_complete: true,
        cursor: '',
        cacheStatus: null,
      } as unknown as KVNamespaceListResult<unknown, string>);

      vi.mocked(r2Bucket.list).mockResolvedValue({
        objects: [{ key: 'svg/svg:nick.eth:unmigrated:classic:gradient:518:518.svg' }],
        truncated: false,
        cursor: undefined,
      } as unknown as R2Objects);

      await imageCacheService.invalidate('nick.eth');

      // KV deletes
      expect(svgCacheKv.delete).toHaveBeenCalledTimes(2);
      // R2 deletes: avatar + SVG prefix items
      expect(r2Bucket.delete).toHaveBeenCalled();
    });
  });

  describe('getTtlConfig', () => {
    it('should return correct TTLs for native/migrated', () => {
      const config = imageCacheService.getTtlConfig('native');
      expect(config.softTtl).toBe(21600);
      expect(config.hardTtl).toBe(86400);
      expect(config.r2MaxAge).toBe(86400);
    });

    it('should return correct TTLs for unmigrated', () => {
      const config = imageCacheService.getTtlConfig('unmigrated');
      expect(config.softTtl).toBe(300);
      expect(config.hardTtl).toBe(1800);
      expect(config.r2MaxAge).toBe(3600);
    });

    it('should return default TTLs for unknown status', () => {
      const config = imageCacheService.getTtlConfig('unknown');
      expect(config.softTtl).toBe(3600);
      expect(config.hardTtl).toBe(21600);
      expect(config.r2MaxAge).toBe(21600);
    });
  });

  describe('Avatar RPC failure (avatarFailed)', () => {
    it('should NOT cache SVG when avatar fetch throws', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockResolvedValue(null);
      // Avatar RPC throws (network error, timeout, etc.)
      vi.mocked(avatarService.getAvatarImage).mockRejectedValue(new Error('RPC timeout'));

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBeDefined();
      expect(result.cacheStatus).toBe('miss');
      // Should NOT write back — avatarFailed prevents caching no-background SVGs
      expect(executionCtx.waitUntil).not.toHaveBeenCalled();
    });

    it('should still cache when avatar is genuinely absent (null)', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockResolvedValue(null);
      // Avatar returns null (name has no avatar set) — not a failure
      vi.mocked(avatarService.getAvatarImage).mockResolvedValue(null);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.cacheStatus).toBe('miss');
      // SHOULD write back — no avatar is a valid state
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntilPromises);
      expect(svgCacheKv.put).toHaveBeenCalled();
    });

    it('tells the caller the avatar failed, and does not let the image service look it up again', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockResolvedValue(null);
      vi.mocked(avatarService.getAvatarImage).mockRejectedValueOnce(new Error('RPC timeout')).mockResolvedValueOnce(null);

      const failed = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);
      const absent = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      // The route uses this to skip the edge cache and send a short Cache-Control.
      expect(failed.avatarFailed).toBe(true);
      expect(absent.avatarFailed).toBe(false);
      // One lookup per render: a second one would double the wait on an outage.
      expect(avatarService.getAvatarImage).toHaveBeenCalledTimes(2);
      expect(avatarService.getAvatarBase64).not.toHaveBeenCalled();
    });
  });

  describe('Stale revalidation with avatar failure', () => {
    it('should skip revalidation write-back when avatar fetch fails during background refresh', async () => {
      // Serve stale entry
      const entry = JSON.stringify({
        svg: '<svg>Stale</svg>',
        createdAt: Date.now() - 400_000,
        softTtl: 300,
        avatarHash: '',
        migrationStatus: 'unmigrated',
      });
      (svgCacheKv.get as Mock).mockResolvedValue(entry);
      // During background revalidation, avatar RPC fails
      vi.mocked(avatarService.getAvatarImage).mockRejectedValue(new Error('timeout'));

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBe('<svg>Stale</svg>');
      expect(result.cacheStatus).toBe('stale');
      // Background revalidation fires but should NOT overwrite cache
      await Promise.all(waitUntilPromises);
      expect(svgCacheKv.put).not.toHaveBeenCalled();
    });
  });

  describe('R2 avatar with content type', () => {
    it('should use an R2 avatar with a stored content type (type re-derived from its bytes)', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      // SVG miss, then avatar hit with JPEG content type
      vi.mocked(r2Bucket.get)
        .mockResolvedValueOnce(null) // SVG key miss
        .mockResolvedValueOnce({     // avatar hit
          arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).buffer),
          httpMetadata: { contentType: 'image/jpeg' },
          text: vi.fn(),
          body: null,
          bodyUsed: false,
        } as unknown as R2ObjectBody);

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.cacheStatus).toBe('miss');
      expect(result.svg).toBeDefined();
      // Avatar RPC should NOT be called — R2 avatar was used
      expect(avatarService.getAvatarImage).not.toHaveBeenCalled();
    });
  });

  describe('R2 read failure', () => {
    it('should fall through to origin when R2 read throws', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockRejectedValue(new Error('R2 unavailable'));

      const result = await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);

      expect(result.svg).toBeDefined();
      expect(result.cacheStatus).toBe('miss');
    });
  });

  describe('Cache key determinism', () => {
    it('should produce different keys for different params', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);
      const firstCallKey = vi.mocked(svgCacheKv.get).mock.calls[0][0];

      (svgCacheKv.get as Mock).mockClear();
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      const differentOptions = {
        ...defaultOptions,
        migrationStatus: 'native' as const,
      };
      await imageCacheService.getImage('nick.eth', differentOptions, executionCtx);
      const secondCallKey = vi.mocked(svgCacheKv.get).mock.calls[0][0];

      expect(firstCallKey).not.toBe(secondCallKey);
      expect(firstCallKey).toContain('unmigrated');
      expect(secondCallKey).toContain('native');
    });

    it('should produce same key for same params', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null);
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);
      const firstCallKey = vi.mocked(svgCacheKv.get).mock.calls[0][0];

      (svgCacheKv.get as Mock).mockClear();
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      await imageCacheService.getImage('nick.eth', defaultOptions, executionCtx);
      const secondCallKey = vi.mocked(svgCacheKv.get).mock.calls[0][0];

      expect(firstCallKey).toBe(secondCallKey);
    });
  });
});
