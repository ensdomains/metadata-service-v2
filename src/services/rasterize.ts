// SVG to PNG rasterization service using rasterize-wasm (lazy font loading from R2)
// @ts-expect-error — rasterize-wasm is a JS-only package without type declarations
import { createRasterizer, setHarfBuzzWasm, setBrotliWasm, decompress, FONT_MANIFEST } from 'rasterize-wasm';
// @ts-expect-error — wrangler bundles .wasm imports as WebAssembly.Module
import resvgWasm from 'rasterize-wasm/wasm/resvg.wasm';
// @ts-expect-error — untyped .wasm module import
import hbWasm from 'harfbuzzjs/hb.wasm';
// @ts-expect-error — wrangler bundles .wasm imports as pre-compiled WebAssembly.Module
import brotliWasm from 'tiny-brotli-dec-wasm/build/tiny-brotli-dec-wasm.wasm';

// Pre-compiled trampoline modules for wrapping JS functions as WASM-callable.
// Workers blocks runtime WASM compilation, so these are compiled at deploy time.
// @ts-expect-error — untyped .wasm trampoline module import
import trampVi from 'harfbuzzjs/trampolines/trampoline-vi.wasm';
// @ts-expect-error — untyped .wasm trampoline module import
import trampViiiffi from 'harfbuzzjs/trampolines/trampoline-viiiffi.wasm';
// @ts-expect-error — untyped .wasm trampoline module import
import trampViiiffffffi from 'harfbuzzjs/trampolines/trampoline-viiiffffffi.wasm';
// @ts-expect-error — untyped .wasm trampoline module import
import trampViiiffffi from 'harfbuzzjs/trampolines/trampoline-viiiffffi.wasm';
// @ts-expect-error — untyped .wasm trampoline module import
import trampViiii from 'harfbuzzjs/trampolines/trampoline-viiii.wasm';
// @ts-expect-error — untyped .wasm trampoline module import
import trampIiiii from 'harfbuzzjs/trampolines/trampoline-iiiii.wasm';

// Make trampolines available to patched harfbuzzjs runtime
(globalThis as any).__WASM_TRAMPOLINES__ = {
  vi: trampVi,
  viiiffi: trampViiiffi,
  viiiffffffi: trampViiiffffffi,
  viiiffffi: trampViiiffffi,
  viiii: trampViiii,
  iiiii: trampIiiii,
};

// Provide harfbuzzjs WASM before any text shaping
setHarfBuzzWasm(hbWasm);

// Provide pre-compiled brotli WASM for decompression in Workers
setBrotliWasm(brotliWasm);

// R2 prefix where fonts are stored
const R2_FONT_PREFIX = 'fonts/';

// Singleton rasterizer — initialized once per isolate
let _rasterizer: any = null;
let _init: { promise: Promise<unknown>; startedAt: number } | null = null;

// The init loads ~29 MB of fonts, so concurrent requests share one in-flight
// init instead of each starting their own (in a 128 MB isolate), and no request
// gives up on it early: however slow, it is waited for, bounded only by the
// request timeout. A failed init is dropped, so the next request retries it.
// The init runs in the request that started it, which registers it with
// waitUntil, so a cancelled request (e.g. a client disconnect) does not cut it
// off. An init can still be stranded if its reads outlast that request's
// lifetime (up to 30 s, plus up to 30 s of waitUntil); past this age it cannot
// still be loading, and the next request starts a fresh one. Two live inits
// never run at once.
export const RASTERIZER_INIT_STALE_MS = 90_000;

async function initRasterizer(bucket: R2Bucket): Promise<any> {
  const manifest = FONT_MANIFEST as {
    fonts: Record<string, string>;
    data: { twemoji: string };
  };

  // Fetch all fonts + twemoji from R2 in parallel
  const fontEntries = Object.entries(manifest.fonts);
  const fontPromises = fontEntries.map(async ([name, filename]) => {
    const obj = await bucket.get(`${R2_FONT_PREFIX}${filename}`);
    if (!obj) throw new Error(`Font not found in R2: ${R2_FONT_PREFIX}${filename}`);
    const compressed = new Uint8Array(await obj.arrayBuffer());
    const data = await decompress(compressed);
    return { name: name.replace(/\+/g, ' '), weight: 700, data };
  });

  const twemojiPromise = (async () => {
    const obj = await bucket.get(`${R2_FONT_PREFIX}${manifest.data.twemoji}`);
    if (!obj) throw new Error(`Twemoji not found in R2: ${R2_FONT_PREFIX}${manifest.data.twemoji}`);
    const compressed = new Uint8Array(await obj.arrayBuffer());
    return decompress(compressed);
  })();

  const [fonts, emojiBytes] = await Promise.all([
    Promise.all(fontPromises),
    twemojiPromise,
  ]);

  return createRasterizer({
    fonts,
    emojiData: new Uint8Array(emojiBytes),
    wasmBuffer: resvgWasm,
  });
}

export interface Rasterizer {
  render(svg: string): Promise<ArrayBuffer | Uint8Array>;
  measureText(text: string, fontSize: number, options: { primaryFont?: ArrayBuffer; features?: string[] }): Promise<number>;
}

// The isolate's rasterizer, initialized on first use. The card's name label is
// measured with it too (see ImageGenerationService), so labels match the PNG.
export async function getRasterizer(bucket: R2Bucket, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Rasterizer> {
  if (!_rasterizer) {
    if (!_init || Date.now() - _init.startedAt > RASTERIZER_INIT_STALE_MS) {
      const init: Promise<unknown> = initRasterizer(bucket).then(
        (r) => {
          _rasterizer ??= r;
          return r;
        },
        (err) => {
          if (_init?.promise === init) _init = null;
          throw err;
        },
      );
      _init = { promise: init, startedAt: Date.now() };
      ctx?.waitUntil(init.catch(() => {}));
    }
    await _init.promise;
  }
  return _rasterizer;
}

export class RasterizeService {
  async rasterize(svg: string, bucket: R2Bucket, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Uint8Array> {
    const pngBuffer = await (await getRasterizer(bucket, ctx)).render(svg);
    return new Uint8Array(pngBuffer);
  }
}
