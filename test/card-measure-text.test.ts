import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

// The ENS v2 card sizes the name's label from a measurement of the name. The
// composer's own measurement is exact for Satoshi's Latin and for CJK, but for
// other scripts and emoji it uses average widths, so in the PNG a Hindi name
// overflowed its label and Arabic, Hangul and emoji labels had empty space.
// Those names are measured with the rasterizer, which draws the PNG.

import { ImageGenerationService } from '../src/services/image';
import type { Rasterizer } from '../src/services/rasterize';

const state = { rasterizer: null as unknown as Rasterizer, fail: false, calls: 0 };
const getRasterizer = async () => {
  state.calls++;
  if (state.fail) throw new Error('Font not found in R2');
  return state.rasterizer;
};

const satoshi = readFileSync(new URL('../node_modules/adaptive-layout-composer/assets/Satoshi-Bold.ttf', import.meta.url));
const satoshiBuffer = satoshi.buffer.slice(satoshi.byteOffset, satoshi.byteOffset + satoshi.byteLength);
const bucket = { get: async () => ({ arrayBuffer: async () => satoshiBuffer }) } as unknown as R2Bucket;
const FEATURES = ['ss01', 'ss03', 'tnum'];

let measure: (text: string, fontSize: number) => Promise<number>;

beforeAll(async () => {
  // @ts-expect-error — rasterize-wasm is a JS-only package without type declarations
  const { createRasterizer, FONT_MANIFEST } = await import('rasterize-wasm');
  const file = (name: string) => new Uint8Array(brotliDecompressSync(readFileSync(new URL(`../node_modules/rasterize-wasm/fonts/${name}`, import.meta.url))));
  const fonts = Object.entries(FONT_MANIFEST.fonts as Record<string, string>)
    .filter(([name]) => ['Noto+Sans', 'Noto+Naskh+Arabic', 'Noto+Sans+Devanagari'].includes(name))
    .map(([name, f]) => ({ name: name.replace(/\+/g, ' '), weight: 700, data: file(f) }));
  state.rasterizer = await createRasterizer({ fonts, emojiData: file(FONT_MANIFEST.data.twemoji) });
  measure = (text, fontSize) => state.rasterizer.measureText(text, fontSize, { primaryFont: satoshiBuffer, features: FEATURES });
}, 60_000);

beforeEach(() => {
  state.fail = false;
  state.calls = 0;
});

const svc = new ImageGenerationService(undefined, getRasterizer);
const card = async (name: string, migrationStatus: 'migrated' | 'unmigrated' = 'migrated') =>
  (await svc.generateDomainImage({ name, migrationStatus }, bucket)).svg;
const label = (svg: string) => ({
  width: Number(/<rect x="74" y="420" width="([\d.]+)"/.exec(svg)![1]),
  fontSize: Number(/font-size="([\d.]+)px"/.exec(svg)![1]),
});

describe('ENS v2 card label', () => {
  it.each(['مرحبا.eth', 'नमस्ते.eth', '🦊🧙🏻‍♂.eth'])('fits %s exactly as the rasterizer draws it', async (name) => {
    const { width, fontSize } = label(await card(name));
    expect(width - 34).toBeCloseTo(await measure(name.replace('🧙🏻‍♂', '🧙🏻‍♂️'), fontSize), 2);
    expect(state.calls).toBe(1);
  }, 60_000);

  it.each(['tanrikulu.eth', '_ens-dao1.eth', '日本語.eth'])('measures %s without starting the rasterizer', async (name) => {
    await card(name);
    expect(state.calls).toBe(0);
  });

  it('draws a name that does not normalize, as given, on its weave', async () => {
    // Such names exist on-chain; the weave hashes the labels as given.
    expect(await card('ab_c.eth')).toContain('>ab_c.eth</text>');
  });

  it('keeps the v1 card off the rasterizer', async () => {
    await card('مرحبا.eth', 'unmigrated');
    expect(state.calls).toBe(0);
  });

  it('falls back to the built-in measurement when the rasterizer cannot start', async () => {
    state.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { width } = label(await card('مرحبا.eth'));
    expect(width).toBeGreaterThan(34);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('built-in measurement'), expect.any(Error));
    warn.mockRestore();
  });
});
