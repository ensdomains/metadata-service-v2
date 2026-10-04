import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type Mock } from 'vitest';
import { ImageCacheService } from '../src/services/image-cache';
import { StorageManager } from '../src/utils/storage';
import { ImageGenerationService } from '../src/services/image';
import { AvatarService } from '../src/services/avatar';
import { sepolia } from 'viem/chains';
import { createMockKV, createMockR2 } from './mocks/hono-env';

// Mock adaptive-layout-composer
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn().mockResolvedValue('<svg>Mock SVG</svg>'),
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
        uploaded: new Date(),
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
        uploaded: new Date(),
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

  describe('W8-CACHE-004: R2 TTL enforcement on binding reads', () => {
    // Freeze Date.now() so boundary tests are deterministic across the mock
    // setup (uploaded timestamp) and the product code (age calculation).
    // Without this, a single-millisecond clock advance can push age just
    // past the boundary and hide the > vs >= bug.
    let fixedNow: number;
    // Retain the exact MockInstance handle so afterEach restores the
    // same spy, not a second one that leaves the original active.
    let dateNowSpy: ReturnType<typeof vi.spyOn>;

    // Capture original Date.now identity before any spy wraps it.
    // afterAll uses this reference for a deterministic assertion —
    // no timing assumptions, no t0/t1 comparison that can be defeated
    // by lucky scheduling.
    const originalNow = Date.now;

    // The SVG generated by the mocked adaptive-layout-composer at L3 origin.
    // Every L3 fallthrough test MUST prove that this fresh SVG is returned
    // and written to KV/R2 — otherwise the backfill assertions are vacuous
    // (avatarFailed skips writes and the test passes silently).
    const ORIGIN_SVG = '<svg>Mock SVG</svg>';

    function r2Object(text: string, ageMs: number): R2ObjectBody {
      return {
        text: vi.fn().mockResolvedValue(text),
        arrayBuffer: vi.fn(),
        body: null,
        bodyUsed: false,
        blob: vi.fn(),
        json: vi.fn(),
        uploaded: new Date(fixedNow - ageMs),
      } as unknown as R2ObjectBody;
    }

    beforeEach(() => {
      fixedNow = Date.now();
      dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    });

    afterEach(() => {
      // Restore the exact spy handle captured in beforeEach.
      // Never vi.restoreAllMocks() — that destroys the module-level
      // vi.mock('../src/services/avatar',…) factory, and subsequent
      // tests see the real AvatarService class.
      dateNowSpy.mockRestore();
    });

    // Helper: drain background writes then assert the L3 origin path
    // positively produced and cached a fresh SVG in KV and R2.  Every
    // L3-fallthrough test must call this so a suppressed write-back
    // (avatarFailed, corrupted mock, etc.) fails loudly rather than
    // passing on a vacuous negative-only check.
    async function assertL3Persisted(ttlConfig: { softTtl: number; hardTtl: number; r2MaxAge: number }) {
      await Promise.all(waitUntilPromises);

      // KV: at least one put call containing the fresh origin SVG
      const kvCalls = (svgCacheKv.put as Mock).mock.calls;
      expect(kvCalls.length, 'KV: expected at least one write-back put').toBeGreaterThan(0);
      const kvEntry = JSON.parse(kvCalls[0][1] as string);
      expect(kvEntry.svg).toBe(ORIGIN_SVG);
      expect(kvEntry.softTtl).toBe(ttlConfig.softTtl);
      // KV expirationTtl must match hardTtl — a hardTtl+1 mutant must fail
      const kvOptions = kvCalls[0][2] as { expirationTtl?: number } | undefined;
      expect(kvOptions?.expirationTtl, 'KV: expirationTtl must equal hardTtl').toBe(ttlConfig.hardTtl);

      // R2: put was called for the fresh SVG with the expected maxAge
      expect(r2Bucket.put, 'R2: expected write-back put').toHaveBeenCalled();
      const r2Call = (r2Bucket.put as Mock).mock.calls[0];
      expect(r2Call[0]).toContain('svg:');
      expect(r2Call[1]).toBe(ORIGIN_SVG);
      const httpMeta = (r2Call[2] as { httpMetadata?: { cacheControl?: string } })?.httpMetadata;
      expect(httpMeta?.cacheControl).toBe(`public, max-age=${ttlConfig.r2MaxAge}`);
    }

    // ── unmigrated (r2MaxAge 3600 s, softTtl 300 s, hardTtl 1800 s) ──

    describe('unmigrated (r2MaxAge 3600 s)', () => {
      const ttl = { softTtl: 300, hardTtl: 1800, r2MaxAge: 3600 };

      it('serves an R2 object 1 ms before r2MaxAge from L2 (age < maxAge)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Fresh R2</svg>', 3600 * 1000 - 1));

        const result = await imageCacheService.getImage('fresh.eth', defaultOptions, executionCtx);

        expect(result.cacheStatus).toBe('stale');
        expect(result.svg).toBe('<svg>Fresh R2</svg>');
        // Remaining lifetime < 60 s — backfill skipped (Cloudflare KV minimum)
        await Promise.all(waitUntilPromises);
        expect((svgCacheKv.put as Mock).mock.calls.length).toBe(0);
      });

      it('rejects R2 at exactly r2MaxAge, falls through to L3, persists fresh SVG (age == maxAge, RFC 9111 stale)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Exact-Boundary R2</svg>', 3600 * 1000));

        const result = await imageCacheService.getImage('exact.eth', defaultOptions, executionCtx);

        // Positive: L3 origin produced a real SVG
        expect(result.cacheStatus).toBe('miss');
        expect(result.avatarFailed).toBe(false);
        expect(result.svg).toBe(ORIGIN_SVG);
        // Negative: the stale R2 bytes were NOT served
        expect(result.svg).not.toBe('<svg>Exact-Boundary R2</svg>');
        // Positive: fresh SVG was persisted to KV and R2 with correct TTLs
        await assertL3Persisted(ttl);
        // Negative: stale R2 bytes were NOT written to KV
        for (const call of (svgCacheKv.put as Mock).mock.calls) {
          expect(typeof call[1] === 'string' ? call[1] : '').not.toContain('Exact-Boundary R2');
        }
      });

      it('rejects R2 1 ms past r2MaxAge, falls through to L3, persists fresh SVG (age > maxAge)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Expired R2</svg>', 3600 * 1000 + 1));

        const result = await imageCacheService.getImage('ttl.eth', defaultOptions, executionCtx);

        expect(result.cacheStatus).toBe('miss');
        expect(result.avatarFailed).toBe(false);
        expect(result.svg).toBe(ORIGIN_SVG);
        expect(result.svg).not.toBe('<svg>Expired R2</svg>');
        await assertL3Persisted(ttl);
        for (const call of (svgCacheKv.put as Mock).mock.calls) {
          expect(typeof call[1] === 'string' ? call[1] : '').not.toContain('Expired R2');
        }
      });
    });

    // ── migrated (r2MaxAge 86400 s, softTtl 21600 s, hardTtl 86400 s) ─

    describe('migrated (r2MaxAge 86400 s)', () => {
      const migratedOptions = { name: 'mig.eth', migrationStatus: 'migrated' as const };
      const ttl = { softTtl: 21600, hardTtl: 86400, r2MaxAge: 86400 };

      it('serves an R2 object 1 ms before r2MaxAge from L2 (age < maxAge)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Mig Fresh R2</svg>', 86400 * 1000 - 1));

        const result = await imageCacheService.getImage('mig.eth', migratedOptions, executionCtx);

        expect(result.cacheStatus).toBe('stale');
        expect(result.svg).toBe('<svg>Mig Fresh R2</svg>');
        // Remaining lifetime < 60 s — backfill skipped
        await Promise.all(waitUntilPromises);
        expect((svgCacheKv.put as Mock).mock.calls.length).toBe(0);
      });

      it('rejects R2 at exactly r2MaxAge, falls through to L3, persists fresh SVG (age == maxAge, RFC 9111 stale)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Mig Exact-Boundary R2</svg>', 86400 * 1000));

        const result = await imageCacheService.getImage('mig.eth', migratedOptions, executionCtx);

        expect(result.cacheStatus).toBe('miss');
        expect(result.avatarFailed).toBe(false);
        expect(result.svg).toBe(ORIGIN_SVG);
        expect(result.svg).not.toBe('<svg>Mig Exact-Boundary R2</svg>');
        await assertL3Persisted(ttl);
        for (const call of (svgCacheKv.put as Mock).mock.calls) {
          expect(typeof call[1] === 'string' ? call[1] : '').not.toContain('Mig Exact-Boundary R2');
        }
      });

      it('rejects R2 1 ms past r2MaxAge, falls through to L3, persists fresh SVG (age > maxAge)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Mig Expired R2</svg>', 86400 * 1000 + 1));

        const result = await imageCacheService.getImage('mig.eth', migratedOptions, executionCtx);

        expect(result.cacheStatus).toBe('miss');
        expect(result.avatarFailed).toBe(false);
        expect(result.svg).toBe(ORIGIN_SVG);
        expect(result.svg).not.toBe('<svg>Mig Expired R2</svg>');
        await assertL3Persisted(ttl);
        for (const call of (svgCacheKv.put as Mock).mock.calls) {
          expect(typeof call[1] === 'string' ? call[1] : '').not.toContain('Mig Expired R2');
        }
      });
    });

    // ── native (r2MaxAge 86400 s) — same TTL as migrated, separate config path ─

    describe('native (r2MaxAge 86400 s)', () => {
      const nativeOptions = { name: 'nat.eth', migrationStatus: 'native' as const };
      const ttl = { softTtl: 21600, hardTtl: 86400, r2MaxAge: 86400 };

      it('rejects R2 at exactly r2MaxAge, falls through to L3, persists fresh SVG (age == maxAge, RFC 9111 stale)', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Nat Exact-Boundary R2</svg>', 86400 * 1000));

        const result = await imageCacheService.getImage('nat.eth', nativeOptions, executionCtx);

        expect(result.cacheStatus).toBe('miss');
        expect(result.avatarFailed).toBe(false);
        expect(result.svg).toBe(ORIGIN_SVG);
        expect(result.svg).not.toBe('<svg>Nat Exact-Boundary R2</svg>');
        await assertL3Persisted(ttl);
        for (const call of (svgCacheKv.put as Mock).mock.calls) {
          expect(typeof call[1] === 'string' ? call[1] : '').not.toContain('Nat Exact-Boundary R2');
        }
      });
    });

    // ── r2MaxAge 0 (degenerate boundary) ─────────────────────────────

    describe('r2MaxAge 0 (degenerate boundary)', () => {
      it('rejects age >= 0 when maxAgeSeconds is 0', async () => {
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Z</svg>', 0));
        expect(await storage.getSvgByKey('z', 0)).toBeNull();
      });

      it('fails closed when uploaded is missing and maxAgeSeconds supplied', async () => {
        vi.mocked(r2Bucket.get).mockResolvedValue({
          text: vi.fn().mockResolvedValue('<svg>Z</svg>'),
          arrayBuffer: vi.fn(),
          body: null, bodyUsed: false, blob: vi.fn(), json: vi.fn(),
        } as unknown as R2ObjectBody);
        expect(await storage.getSvgByKey('z', 3600)).toBeNull();
      });

      it('fails closed when uploaded.getTime() is NaN and maxAgeSeconds supplied', async () => {
        vi.mocked(r2Bucket.get).mockResolvedValue({
          text: vi.fn().mockResolvedValue('<svg>Z</svg>'),
          arrayBuffer: vi.fn(),
          body: null, bodyUsed: false, blob: vi.fn(), json: vi.fn(),
          uploaded: new Date('invalid'),
        } as unknown as R2ObjectBody);
        expect(await storage.getSvgByKey('z', 3600)).toBeNull();
      });
    });

    // ── undefined maxAgeSeconds (backward compatibility) ──────────────

    describe('undefined maxAgeSeconds (backward compatibility)', () => {
      it('serves an R2 object regardless of age when maxAgeSeconds is not passed', async () => {
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>Ancient R2</svg>', 10_000_000));

        const result = await storage.getSvgByKey('ancient-test');

        // Undefined maxAgeSeconds means unbounded — serve regardless of age
        expect(result).not.toBeNull();
        expect(result!.svg).toBe('<svg>Ancient R2</svg>');
      });
    });

    // ── R2 backfill lifetime capping + absolute expiration ──────────
    // R2→L1 backfill must use an absolute KV `expiration` epoch deadline
    // (immune to body-latency clock drift), back-date createdAt to the
    // authoritative R2 upload time, floor softTtl to integer, skip when
    // remaining < 60 s, and fail closed on missing/invalid uploaded.

    describe('R2 backfill lifetime capping', () => {
      function assertL2Backfill(r2AgeMs: number, r2MaxAge: number, expectedSoftTtl: number) {
        const kvCalls = (svgCacheKv.put as Mock).mock.calls;
        expect(kvCalls.length, 'KV: expected backfill put').toBeGreaterThan(0);
        const entry = JSON.parse(kvCalls[0][1] as string);
        const kvOptions = kvCalls[0][2] as { expirationTtl?: number; expiration?: number } | undefined;

        // createdAt must equal the authoritative R2 upload time
        expect(entry.createdAt).toBe(fixedNow - r2AgeMs);
        // softTtl must be floored to integer, capped to remaining lifetime
        expect(entry.softTtl).toBe(expectedSoftTtl);
        // Must use absolute `expiration` epoch, not relative expirationTtl
        expect(kvOptions?.expiration).toBe(Math.floor((fixedNow - r2AgeMs) / 1000) + r2MaxAge);
        expect(kvOptions?.expirationTtl).toBeUndefined();
        // migrationStatus must match the options passed in
        expect(entry.migrationStatus).toBeTruthy();
      }

      // ── skip near / boundary ───────────────────────────────────────

      it('skips backfill when remaining < 60 s', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', 3600 * 1000 - 1));
        await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
        await Promise.all(waitUntilPromises);
        expect((svgCacheKv.put as Mock).mock.calls.length).toBe(0);
      });

      it('skips at 59.999 s remaining', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', 3540 * 1000 + 1));
        await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
        await Promise.all(waitUntilPromises);
        expect((svgCacheKv.put as Mock).mock.calls.length).toBe(0);
      });

      it('backfills at exactly 60 s remaining (integer clock, expiration >= ceil+60)', async () => {
        const savedNow = fixedNow;
        // Use integer-aligned now for exact boundary
        fixedNow = Math.floor(savedNow / 1000) * 1000;
        dateNowSpy?.mockReturnValue(fixedNow);
        try {
          (svgCacheKv.get as Mock).mockResolvedValue(null);
          const ms = 3540 * 1000;
          vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
          await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
          await Promise.all(waitUntilPromises);
          assertL2Backfill(ms, 3600, 60);
        } finally {
          fixedNow = savedNow;
          dateNowSpy?.mockReturnValue(fixedNow);
        }
      });

      it('backfills at 60.001 s remaining (integer clock, expiration >= ceil+60)', async () => {
        const savedNow = fixedNow;
        fixedNow = Math.floor(savedNow / 1000) * 1000;
        dateNowSpy?.mockReturnValue(fixedNow);
        try {
          (svgCacheKv.get as Mock).mockResolvedValue(null);
          const ms = 3540 * 1000 - 1;
          vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
          await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
          await Promise.all(waitUntilPromises);
          assertL2Backfill(ms, 3600, 60);
        } finally {
          fixedNow = savedNow;
          dateNowSpy?.mockReturnValue(fixedNow);
        }
      });

      // ── KV fractional clock ──────────────────────────────────────
      // With now ending at .500 fractional seconds, remaining 60.001 s
      // produces integer expiration only 59.5 s ahead → must skip.
      it('skips KV put when integer expiration < 60 s despite nominal remaining 60.001', async () => {
        const savedNow = fixedNow;
        // Set now to a value ending in .500 fractional seconds
        fixedNow = Math.floor(savedNow / 1000) * 1000 + 500;
        dateNowSpy?.mockReturnValue(fixedNow);
        try {
          (svgCacheKv.get as Mock).mockResolvedValue(null);
          const ms = 3540 * 1000 - 1; // nominal remaining 60.001 s
          vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
          await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
          await Promise.all(waitUntilPromises);
          // Integer expiration = floor(uploadedMs/1000) + 3600
          // = floor((fixedNow - ms)/1000) + 3600
          // = floor((500ms + N*1000 - 3539999)/1000) + 3600
          // = ... expires 59.5 s ahead → skip
          expect((svgCacheKv.put as Mock).mock.calls.length).toBe(0);
        } finally {
          fixedNow = savedNow;
          dateNowSpy?.mockReturnValue(fixedNow);
        }
      });

      it('backfills when integer expiration >= 60 s at exact integer boundary', async () => {
        const savedNow = fixedNow;
        fixedNow = Math.floor(savedNow / 1000) * 1000;
        dateNowSpy?.mockReturnValue(fixedNow);
        try {
          (svgCacheKv.get as Mock).mockResolvedValue(null);
          const ms = 3540 * 1000; // remaining exactly 60 s
          vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
          await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
          await Promise.all(waitUntilPromises);
          assertL2Backfill(ms, 3600, 60);
        } finally {
          fixedNow = savedNow;
          dateNowSpy?.mockReturnValue(fixedNow);
        }
      });

      // ── unmigrated capping ─────────────────────────────────────────

      it('caps unmigrated when remaining < hardTtl, within softTtl range', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        const ms = 3000 * 1000;
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
        await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
        await Promise.all(waitUntilPromises);
        assertL2Backfill(ms, 3600, 300);
      });

      it('caps both unmigrated softTtl and expiration when remaining < softTtl', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        const ms = 3500 * 1000;
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
        await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
        await Promise.all(waitUntilPromises);
        assertL2Backfill(ms, 3600, 100);
      });

      // ── migrated capping ───────────────────────────────────────────

      it('caps migrated expiration to remaining', async () => {
        const opts = { name: 'm.eth', migrationStatus: 'migrated' as const };
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        const ms = 50000 * 1000;
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
        await imageCacheService.getImage('m.eth', opts, executionCtx);
        await Promise.all(waitUntilPromises);
        assertL2Backfill(ms, 86400, 21600);
      });

      // ── native capping ─────────────────────────────────────────────

      it('caps native expiration to remaining', async () => {
        const opts = { name: 'n.eth', migrationStatus: 'native' as const };
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        const ms = 50000 * 1000;
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', ms));
        await imageCacheService.getImage('n.eth', opts, executionCtx);
        await Promise.all(waitUntilPromises);
        assertL2Backfill(ms, 86400, 21600);
      });

      // ── migrationStatus serialisation ──────────────────────────────

      it('serialises unmigrated status', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', 100 * 1000));
        await imageCacheService.getImage('x.eth', defaultOptions, executionCtx);
        await Promise.all(waitUntilPromises);
        expect(JSON.parse((svgCacheKv.put as Mock).mock.calls[0][1] as string).migrationStatus).toBe('unmigrated');
      });

      it('serialises migrated status', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', 100 * 1000));
        await imageCacheService.getImage('x.eth', { name: 'x.eth', migrationStatus: 'migrated' as const }, executionCtx);
        await Promise.all(waitUntilPromises);
        expect(JSON.parse((svgCacheKv.put as Mock).mock.calls[0][1] as string).migrationStatus).toBe('migrated');
      });

      it('serialises native status', async () => {
        (svgCacheKv.get as Mock).mockResolvedValue(null);
        vi.mocked(r2Bucket.get).mockResolvedValue(r2Object('<svg>X</svg>', 100 * 1000));
        await imageCacheService.getImage('x.eth', { name: 'x.eth', migrationStatus: 'native' as const }, executionCtx);
        await Promise.all(waitUntilPromises);
        expect(JSON.parse((svgCacheKv.put as Mock).mock.calls[0][1] as string).migrationStatus).toBe('native');
      });
    });

    // Guaranteed by vitest lifecycle to run after every per-test afterEach
    // in this describe block, regardless of execution order.  No timing
    // assumptions: identity comparison against the original function
    // reference and vi.isMockFunction are deterministic.
    afterAll(() => {
      // Clock: Date.now must be the original function, not a mocked spy.
      // A leaked spy (no-restore or restore-new-spy mutant) leaves
      // a mock wrapper whose identity differs from originalNow.
      expect(Date.now, 'Date.now must be original function after W8 group').toBe(originalNow);
      expect(vi.isMockFunction(Date.now), 'Date.now must not be mocked after W8 group').toBe(false);

      // Module mocks: AvatarService factory mock must be intact.
      // vi.restoreAllMocks() in a per-test afterEach would have destroyed
      // the module-level vi.mock factory, making getAvatarImage throw.
      const svc = new AvatarService('https://test.rpc', sepolia);
      expect(() => svc.getAvatarImage('sentinel.eth'), 'AvatarService mock must be intact').not.toThrow();
    });
  });

  // P1 deployment gap: pre-fix v2 KV entries written with backfill-time
  // createdAt / full TTL remain L1 hits after deploy, bypassing R2 deadline
  // enforcement.  The fix bumps CARD_CACHE_VERSION so old v2 keys miss and
  // fall through to authoritative L2/L3.  No explicit old-key deletion is
  // required — orphaned v2 keys expire on their own TTL or via the
  // version-agnostic invalidation prefix.
  describe('W8-CACHE-004: cache generation bump (v2 legacy isolation)', () => {
    function legacyV2Entry(svg: string, migrationStatus: string): string {
      return JSON.stringify({
        svg,
        createdAt: Date.now(), // pre-fix backfill-time reset
        softTtl: migrationStatus === 'unmigrated' ? 300 : 21600,
        avatarHash: '',
        migrationStatus,
      });
    }

    // Simulate the real KV namespace: old v2 keys return pre-fix entries,
    // any other generation keys miss.
    function mockV2OnlyGet(entry: string): void {
      (svgCacheKv.get as Mock).mockImplementation((key: string) => {
        if (key.endsWith(':v2')) return Promise.resolve(entry);
        return Promise.resolve(null);
      });
    }

    it('does not serve a legacy v2 unmigrated KV entry after generation bump', async () => {
      mockV2OnlyGet(legacyV2Entry('<svg>Legacy v2 Stale</svg>', 'unmigrated'));
      vi.mocked(r2Bucket.get).mockResolvedValue(null); // L2 miss

      const result = await imageCacheService.getImage('legacy.eth', defaultOptions, executionCtx);

      // Must miss v2, fall through to L3 origin, never serve pre-fix bytes
      expect(result.svg).not.toBe('<svg>Legacy v2 Stale</svg>');
      expect(result.cacheStatus).toBe('miss');
    });

    it('does not serve a legacy v2 migrated KV entry after generation bump', async () => {
      mockV2OnlyGet(legacyV2Entry('<svg>Legacy Mig v2</svg>', 'migrated'));
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      const result = await imageCacheService.getImage('legacy.eth', { name: 'legacy.eth', migrationStatus: 'migrated' as const }, executionCtx);

      expect(result.svg).not.toBe('<svg>Legacy Mig v2</svg>');
      expect(result.cacheStatus).toBe('miss');
    });

    it('does not serve a legacy v2 native KV entry after generation bump', async () => {
      mockV2OnlyGet(legacyV2Entry('<svg>Legacy Nat v2</svg>', 'native'));
      vi.mocked(r2Bucket.get).mockResolvedValue(null);

      const result = await imageCacheService.getImage('legacy.eth', { name: 'legacy.eth', migrationStatus: 'native' as const }, executionCtx);

      expect(result.svg).not.toBe('<svg>Legacy Nat v2</svg>');
      expect(result.cacheStatus).toBe('miss');
    });

    it('serves a fresh current-generation KV entry as L1 hit', async () => {
      const fresh = JSON.stringify({
        svg: '<svg>Fresh Generation</svg>',
        createdAt: Date.now(),
        softTtl: 300,
        avatarHash: '',
        migrationStatus: 'unmigrated',
      });
      (svgCacheKv.get as Mock).mockResolvedValue(fresh);

      const result = await imageCacheService.getImage('fresh.eth', defaultOptions, executionCtx);

      expect(result.cacheStatus).toBe('hit');
      expect(result.svg).toBe('<svg>Fresh Generation</svg>');
    });

    it('writes back with the same generation key it reads (no write/read split)', async () => {
      (svgCacheKv.get as Mock).mockResolvedValue(null); // L1 miss
      vi.mocked(r2Bucket.get).mockResolvedValue(null); // L2 miss

      await imageCacheService.getImage('wb.eth', defaultOptions, executionCtx);
      await Promise.all(waitUntilPromises);

      // Read key (KV get) and write key (KV put) must share the same
      // generation suffix — a write-only or read-only bump would diverge.
      const readKey = (svgCacheKv.get as Mock).mock.calls[0][0] as string;
      const writeKey = (svgCacheKv.put as Mock).mock.calls[0][0] as string;
      expect(writeKey).toBe(readKey);
    });
  });
});
