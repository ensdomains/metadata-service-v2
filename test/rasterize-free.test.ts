import { describe, it, expect, afterAll } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';

// rasterize-wasm (since 1.0.2) frees resvg's render objects after each render.
// Left to the FinalizationRegistry, the parsed tree and the rendered pixmap
// stay in WebAssembly memory until a GC runs, and WebAssembly memory never
// shrinks: with a 2000px card holding a 1080px avatar it was 43 MB after one
// render and 166 MB after eight, against a 128 MB isolate. This pins the fix,
// so a dependency change that loses it fails here.

// resvg's WebAssembly memory, captured as rasterize-wasm instantiates it.
const memories: WebAssembly.Memory[] = [];
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = (async (...args: Parameters<typeof WebAssembly.instantiate>) => {
  const result = await (instantiate as (...a: unknown[]) => Promise<unknown>)(...args);
  const instance = (result as { instance?: WebAssembly.Instance }).instance ?? (result as WebAssembly.Instance);
  const memory = instance.exports?.memory;
  if (memory instanceof WebAssembly.Memory) memories.push(memory);
  return result;
}) as typeof WebAssembly.instantiate;

afterAll(() => {
  WebAssembly.instantiate = instantiate;
});

// A width x height RGBA PNG (all zero: decoding still allocates the full bitmap).
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height); // filter byte 0 per row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('rasterize-wasm render objects', () => {
  it('are freed after each render, so resvg memory does not grow across renders', async () => {
    // @ts-expect-error — rasterize-wasm is a JS-only package without type declarations
    const { SVGRenderer } = await import('rasterize-wasm');
    const avatar = png(1024, 1024).toString('base64');
    // The card's largest output size, with an avatar at the rasterize cap.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000" viewBox="0 0 1000 1000">`
      + `<rect width="1000" height="1000" fill="#7C3AED"/>`
      + `<image href="data:image/png;base64,${avatar}" x="241" y="241" width="518" height="518"/></svg>`;

    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out: Uint8Array = await SVGRenderer.renderSVGToPNG(svg, { fitTo: { mode: 'original' } });
      expect(Buffer.from(out.subarray(1, 4)).toString('ascii')).toBe('PNG');
      sizes.push(memories.at(-1)!.buffer.byteLength);
    }

    // Unfreed, each render here added tens of MB.
    expect(sizes.at(-1)! - sizes[0]).toBeLessThan(8 * 1024 * 1024);
  }, 60_000);
});
