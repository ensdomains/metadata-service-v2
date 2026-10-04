import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// The /rasterize route renders the NFT card to PNG with resvg inside the Worker
// (30s CPU limit), and the card embeds the owner's avatar. An SVG avatar makes
// that render attacker-controlled work whose cost is unbounded by its size:
// the 0.7 KiB avatar below (<use> fan-out of 100 blurred full-canvas rects)
// measured ~29s in resvg, 100 blurred rects in 8 KiB ~19s, 1000 plain rects in
// 63 KiB ~51s at the 2000px output size. The rasterized card therefore never
// carries an SVG avatar; the /image SVG card (rendered by the client) and
// raster avatars are unchanged. The layout composer is NOT mocked here: the
// replacement must match the markup the real composer emits.

// Headers only: the rasterizer is mocked, and forRasterization reads just the
// declared pixel size.
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}
const PNG = pngHeader(400, 400);
const HOSTILE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500"><defs>' +
    '<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50"/></filter>' +
    '<rect id="l0" width="500" height="500" fill="#08f" fill-opacity="0.05" filter="url(#b)"/>' +
    `<g id="l1">${'<use href="#l0"/>'.repeat(10)}</g><g id="l2">${'<use href="#l1"/>'.repeat(10)}</g>` +
    '</defs><use href="#l2"/></svg>',
);
const svgB64 = HOSTILE_SVG.toString('base64');
const pngB64 = PNG.toString('base64');

// The route mocks below hand out whatever card the test put here.
const state = vi.hoisted(() => ({ card: '', rasterized: [] as string[], getImageOptions: null as Record<string, unknown> | null }));

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize(svg: string) {
      state.rasterized.push(svg);
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

vi.mock('../src/services/image-cache', () => ({
  ImageCacheService: class {
    async getImage(_name: string, options: Record<string, unknown>) {
      state.getImageOptions = options;
      return {
        svg: state.card,
        contentType: 'image/svg+xml',
        cacheStatus: 'hit',
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
import { ImageGenerationService } from '../src/services/image';
import type { MigrationStatus } from '../src/types';

const svc = new ImageGenerationService();
const collapse = (svg: string) => svg.replace(/>\s+</g, '><').trim();

async function card(name: string, opts: { avatarBase64?: string; avatarMimeType?: string; migrationStatus?: MigrationStatus; size?: { width: number; height: number } } = {}) {
  return (await svc.generateDomainImage({ name, ...opts })).svg;
}

beforeEach(() => {
  state.card = '';
  state.rasterized = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ImageGenerationService.forRasterization', () => {
  it.each(['unmigrated', 'migrated', 'native'] as const)(
    'turns a %s card with an SVG avatar into exactly the no-avatar card',
    async (migrationStatus) => {
      const withAvatar = await card('nick.eth', { avatarBase64: svgB64, avatarMimeType: 'image/svg+xml', migrationStatus });
      expect(withAvatar).toContain(`data:image/svg+xml;base64,${svgB64}`);

      const stripped = svc.forRasterization(withAvatar, 'nick.eth', migrationStatus);
      expect(stripped).not.toContain('data:image/svg+xml');
      expect(collapse(stripped)).toBe(collapse(await card('nick.eth', { migrationStatus })));
    },
  );

  it('uses the character-set colour and the custom card size', async () => {
    const size = { width: 800, height: 600 };
    const withAvatar = await card('a-b.eth', { avatarBase64: svgB64, avatarMimeType: 'image/svg+xml', size });
    const stripped = svc.forRasterization(withAvatar, 'a-b.eth');
    expect(stripped).toContain('<rect width="800" height="600" fill="#4ECDC4"/>');
    expect(collapse(stripped)).toBe(collapse(await card('a-b.eth', { size })));
  });

  it('leaves a card with a raster avatar untouched', async () => {
    const withAvatar = await card('nick.eth', { avatarBase64: pngB64, avatarMimeType: 'image/png' });
    expect(svc.forRasterization(withAvatar, 'nick.eth')).toBe(withAvatar);
  });

  it('fails closed when an SVG data URI survives in other markup', () => {
    const odd = `<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href='data:image/svg+xml;base64,${svgB64}' width="518" height="518"/></svg>`;
    expect(() => svc.forRasterization(odd, 'nick.eth')).toThrow(/unexpected embedded data URI/);
  });
});

describe('/rasterize never hands an SVG avatar to resvg', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

  it('renders a card with an SVG avatar on the no-avatar background; /image keeps the avatar', async () => {
    state.card = await card('nick.eth', { avatarBase64: svgB64, avatarMimeType: 'image/svg+xml' });
    const res = await req('/mainnet/registry/nick.eth/rasterize');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(state.rasterized).toHaveLength(1);
    expect(state.rasterized[0]).not.toContain('data:image/svg+xml');
    expect(state.rasterized[0]).toContain('<rect width="518" height="518" fill="#1F2937"/>');

    // The same (cached) card is served as SVG, rendered by the client, unchanged.
    const image = await req('/mainnet/registry/nick.eth/image');
    expect(image.status).toBe(200);
    expect(await image.text()).toContain(`data:image/svg+xml;base64,${svgB64}`);
  });

  it('also at a custom square output size', async () => {
    state.card = await card('nick.eth', { avatarBase64: svgB64, avatarMimeType: 'image/svg+xml' });
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=2000&h=2000');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).not.toContain('data:image/svg+xml');
    expect(state.rasterized[0]).toMatch(/^<svg width="2000" height="2000"/);
  });

  it('replaces only an SVG avatar: a raster avatar card is rasterized unchanged', async () => {
    const svgCard = await card('nick.eth', { avatarBase64: svgB64, avatarMimeType: 'image/svg+xml' });
    const pngCard = await card('nick.eth', { avatarBase64: pngB64, avatarMimeType: 'image/png' });
    for (const c of [svgCard, pngCard]) {
      state.card = c;
      expect((await req('/mainnet/registry/nick.eth/rasterize')).status).toBe(200);
    }
    expect(state.rasterized).toHaveLength(2);
    expect(collapse(state.rasterized[0])).toBe(collapse(await card('nick.eth')));
    expect(state.rasterized[1]).toBe(pngCard);
  });

  it('refuses (500) rather than rasterize an SVG avatar it cannot replace', async () => {
    state.card = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;utf8,<svg/>" width="518" height="518"/></svg>`;
    const res = await req('/mainnet/registry/nick.eth/rasterize');
    expect(res.status).toBe(500);
    expect(state.rasterized).toHaveLength(0);
  });
});

describe('rasterize dimensions (W8-RASTER-001)', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

  beforeEach(async () => {
    state.card = await card('nick.eth');
    state.rasterized = [];
    state.getImageOptions = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // T1 — Malformed width: w=100a parses as 100 on base → square rewrite to 100×100.
  // After fix w=100a is rejected → null → hasCustomSize false → default 518×518.
  it('ignores a malformed width (T1)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=100a&h=100');
    expect(res.status).toBe(200);
    // Red on base: width="100" (rewritten). Green after fix: width="518" (default).
    expect(state.rasterized[0]).not.toMatch(/ width="100"/);
    expect(state.rasterized[0]).toMatch(/ width="518"/);
  });

  // T2 — Malformed height: h=200b parses as 200 on base → square rewrite to 200×200.
  it('ignores a malformed height (T2)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=200&h=200b');
    expect(res.status).toBe(200);
    // Red on base: width="200" (rewritten). Green after fix: width="518" (default).
    expect(state.rasterized[0]).not.toMatch(/ width="200"/);
    expect(state.rasterized[0]).toMatch(/ width="518"/);
  });

  // T3 — Malformed both (non-square): w=100a→100, h=101b→101. On base options.size
  // is set to {width:100,height:101}; after fix both are null, no size is supplied.
  it('ignores two malformed values and supplies no size (T3)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=100a&h=101b');
    expect(res.status).toBe(200);
    // Red on base: getImageOptions.size = {width:100,height:101}.
    // Green after fix: getImageOptions has no size property.
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T4 — Missing width, clean height: must not supply a partial custom size.
  it('supplies no custom size when only height is present (T4)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?h=200');
    expect(res.status).toBe(200);
    // Green on base already: outputWidth is null → hasCustomSize is false.
    // Guards against a future regression that tries to supply a one-param size.
    expect(state.rasterized[0]).toMatch(/ width="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T5 — Clean square custom size: pure decimal, within range → applied.
  it('accepts a clean square custom size (T5)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=250&h=250');
    expect(res.status).toBe(200);
    // Must be rewritten to the requested size.
    expect(state.rasterized[0]).toMatch(/^<svg width="250" height="250"/);
  });

  // T6 — Out-of-range clean values: 99 < 100 → hasCustomSize is already false.
  it('ignores out-of-range clean values (T6)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=99&h=99');
    expect(res.status).toBe(200);
    // Green on base, guards against the regex fix accidentally widening the range.
    expect(state.rasterized[0]).toMatch(/ width="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });
});
