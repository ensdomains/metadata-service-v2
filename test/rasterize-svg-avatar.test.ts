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
import { ImageGenerationService, weaveBackground } from '../src/services/image';
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

  it("uses the name's weave on an ENS v2 card, at the custom card size", async () => {
    const size = { width: 800, height: 600 };
    const withAvatar = await card('a-b.eth', { avatarBase64: svgB64, avatarMimeType: 'image/svg+xml', migrationStatus: 'migrated', size });
    const stripped = svc.forRasterization(withAvatar, 'a-b.eth', 'migrated');
    expect(stripped).toContain(weaveBackground('a-b.eth', 800, 600));
    expect(collapse(stripped)).toBe(collapse(await card('a-b.eth', { migrationStatus: 'migrated', size })));
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

  // --- malformed values (T1–T3) ---

  // T1 — Malformed width square: w=100a parses as 100 on base → square rewrite.
  it('ignores a malformed width (T1)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=100a&h=100');
    expect(res.status).toBe(200);
    // Root SVG must not carry the attacker value; must be default 518.
    expect(state.rasterized[0]).not.toMatch(/^<svg width="100"/);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
  });

  // T2 — Malformed height square: h=200b parses as 200 on base → square rewrite.
  it('ignores a malformed height (T2)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=200&h=200b');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).not.toMatch(/^<svg width="200"/);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
  });

  // T3a — Malformed both (non-square): w=100a→100, h=101b→101 → options.size set on base.
  it('ignores two malformed non-square values, no size supplied (T3a)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=100a&h=101b');
    expect(res.status).toBe(200);
    // Red on base: getImageOptions.size = {width:100,height:101}.
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T3b — Malformed both (square): w=150x&h=150x both parse to 150 → square rewrite on base.
  it('ignores two malformed square values (T3b)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=150x&h=150x');
    expect(res.status).toBe(200);
    // Red on base: root SVG rewritten to width="150".
    expect(state.rasterized[0]).not.toMatch(/^<svg width="150"/);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
  });

  // --- incomplete pairs (T4a, T4b) ---

  // T4a — Missing width, clean height: must not supply a partial custom size.
  it('supplies no custom size when only height is present (T4a)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?h=200');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T4b — Missing height, clean width: the reverse incomplete-pair direction.
  it('supplies no custom size when only width is present (T4b)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=200');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // --- clean custom sizes: square + non-square (T5) ---

  // T5a — Clean square: pure decimal, within range → applied (rewrite).
  it('accepts a clean square custom size (T5a)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=250&h=250');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="250" height="250"/);
  });

  // T5b — Valid non-square: options.size set, no SVG rewrite.
  it('accepts a valid non-square custom size (T5b)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=200&h=300');
    expect(res.status).toBe(200);
    // Non-square: options.size is set but SVG is left at default (mock ignores size).
    expect(state.getImageOptions).toHaveProperty('size');
    expect(state.getImageOptions!.size).toEqual({ width: 200, height: 300 });
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
  });

  // T5c — Extreme spread low-high: kills square-only (outputWidth===outputHeight) mutant.
  it('accepts 100×2000 non-square (T5c)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=100&h=2000');
    expect(res.status).toBe(200);
    expect(state.getImageOptions).toHaveProperty('size');
    expect(state.getImageOptions!.size).toEqual({ width: 100, height: 2000 });
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
  });

  // T5d — Extreme spread high-low: kills square-only mutant in reverse direction.
  it('accepts 2000×100 non-square (T5d)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=2000&h=100');
    expect(res.status).toBe(200);
    expect(state.getImageOptions).toHaveProperty('size');
    expect(state.getImageOptions!.size).toEqual({ width: 2000, height: 100 });
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
  });

  // --- boundary values (T6a–T6e) ---

  // T6a — Below lower bound: 99 < 100 → ignored.
  it('ignores below-lower-bound values (T6a)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=99&h=99');
    expect(res.status).toBe(200);
    // Anchored: root SVG, not the background rect.
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T6b — Exact lower bound: 100 → accepted (kills >100 exclusive mutant).
  it('accepts exact lower bound (T6b)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=100&h=100');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="100" height="100"/);
  });

  // T6c — Exact upper bound: 2000 → accepted.
  it('accepts exact upper bound (T6c)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=2000&h=2000');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="2000" height="2000"/);
  });

  // T6d — Above upper bound: 2001 > 2000 → ignored.
  it('ignores above-upper-bound values (T6d)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=2001&h=2001');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T6e — Cross-boundary: one in range, one out → both ignored (no partial size).
  it('ignores cross-boundary pairs (T6e)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=99&h=100');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T6f — Valid width, height below lower bound → ignores pair (kills height-only mutant).
  it('ignores valid width with too-low height (T6f)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=200&h=99');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T6g — Valid height, width below lower bound → ignores pair (kills width-only mutant).
  it('ignores valid height with too-low width (T6g)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=99&h=200');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T6h — Valid width, height above upper bound → ignores pair (kills height-only mutant).
  it('ignores valid width with too-high height (T6h)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=200&h=2001');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // T6i — Valid height, width above upper bound → ignores pair (kills width-only mutant).
  it('ignores valid height with too-high width (T6i)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=2001&h=200');
    expect(res.status).toBe(200);
    expect(state.rasterized[0]).toMatch(/^<svg width="518" height="518"/);
    expect(state.getImageOptions).not.toHaveProperty('size');
  });

  // --- leading zeros (T7) ---

  // T7 — Leading zeros: pure decimal, /^\d+$/ accepts; parseInt('0100',10)→100.
  it('accepts leading-zero decimal spellings (T7)', async () => {
    const res = await req('/mainnet/registry/nick.eth/rasterize?w=0100&h=0100');
    expect(res.status).toBe(200);
    // Must be accepted as 100×100, killing a /^[1-9]\d*$/ rejection mutant.
    expect(state.rasterized[0]).toMatch(/^<svg width="100" height="100"/);
  });
});
