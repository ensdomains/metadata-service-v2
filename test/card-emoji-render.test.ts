import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { ImageGenerationService } from '../src/services/image';

// The card shows the name as ENS displays it (ens_beautify), with FE0F on
// every emoji, so the rasterizer finds the twemoji for a sequence such as
// 🧙🏻‍♂ (keyed with FE0F) that the normalized name carries without it.
// Rendered through the real composer and rasterizer: the card for
// 🦊🧙🏻‍♂.eth must differ from the same card rendered with no image for the
// mage, which is what any step that drops the emoji would produce.

const MAGE = '\u{1F9D9}\u{1F3FB}‍♂';

describe('the card for a name with an FE0F-less emoji', () => {
  it('draws the emoji on /rasterize', async () => {
    const svc = new ImageGenerationService();
    const name = `\u{1F98A}${MAGE}.eth`; // normalized: no FE0F
    const card = svc.forRasterization((await svc.generateDomainImage({ name })).svg, name);
    expect(card).toContain(`${MAGE}️`); // the composer kept the FE0F

    // @ts-expect-error — rasterize-wasm is a JS-only package without type declarations
    const { createRasterizer, FONT_MANIFEST } = await import('rasterize-wasm');
    const emojiFile = new URL(`../node_modules/rasterize-wasm/fonts/${FONT_MANIFEST.data.twemoji}`, import.meta.url);
    const emoji: Record<string, unknown> = JSON.parse(brotliDecompressSync(readFileSync(emojiFile)).toString());
    // The rasterizer's emoji data is global: render with each set in turn.
    const render = async (emojiData: Record<string, unknown>) =>
      Buffer.from(await (await createRasterizer({ fonts: [], emojiData })).render(card));

    const drawn = await render(emoji);
    const withoutMage = await render(Object.fromEntries(Object.entries(emoji).filter(([key]) => !key.startsWith('1f9d9'))));
    expect(drawn.equals(withoutMage)).toBe(false);
  }, 60_000);
});
