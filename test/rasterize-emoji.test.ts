import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

// rasterize-wasm (since 1.0.3) draws an emoji whose twemoji image is keyed with
// FE0F when the text has none. ENS names are normalized without FE0F, so before
// it 🧙🏻‍♂ or ❤‍🔥 in a name rendered as a blank gap on /rasterize.

let render: (text: string) => Promise<Buffer>;

beforeAll(async () => {
  // @ts-expect-error — rasterize-wasm is a JS-only package without type declarations
  const { createRasterizer, FONT_MANIFEST } = await import('rasterize-wasm');
  const emojiFile = new URL(`../node_modules/rasterize-wasm/fonts/${FONT_MANIFEST.data.twemoji}`, import.meta.url);
  const rasterizer = await createRasterizer({ fonts: [], emojiData: new Uint8Array(brotliDecompressSync(readFileSync(emojiFile))) });
  render = async (text) => Buffer.from(await rasterizer.render(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">'
      + '<rect width="300" height="200" fill="#7C3AED"/>'
      + `<text x="20" y="140" font-size="120" fill="white">${text}</text></svg>`,
  ));
});

describe('rasterize-wasm emoji', () => {
  it.each([
    ['🧙🏻‍♂ (FE0F at the end of its twemoji key)', '\u{1F9D9}\u{1F3FB}‍♂', '\u{1F9D9}\u{1F3FB}‍♂️'],
    ['❤‍🔥 (FE0F inside its twemoji key)', '❤‍\u{1F525}', '❤️‍\u{1F525}'],
  ])('draws %s without FE0F as it draws it with FE0F', async (_label, bare, withFe0f) => {
    const drawn = await render(withFe0f);
    expect(drawn.equals(await render(''))).toBe(false); // the emoji is drawn at all
    expect((await render(bare)).equals(drawn)).toBe(true);
  }, 60_000);
});
