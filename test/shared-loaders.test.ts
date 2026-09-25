import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The font loader and the rasterizer init are memoized per isolate. Their
// in-flight load used to be one promise shared by every request: when the
// request that started it was cancelled, its R2 reads never settled and every
// later request on the isolate hung on that promise; a failed rasterizer init
// was cached, so every later /rasterize failed until the isolate was recycled.

const createRasterizer = vi.fn();
vi.mock('rasterize-wasm', () => ({
  createRasterizer: (...args: unknown[]) => createRasterizer(...args),
  setHarfBuzzWasm: () => {},
  setBrotliWasm: () => {},
  decompress: async (bytes: Uint8Array) => bytes,
  FONT_MANIFEST: { fonts: { 'Noto+Sans': 'noto-sans-bold.ttf.br' }, data: { twemoji: 'twemoji.json.br' } },
}));
// The .wasm imports resolve to test/mocks/wasm-stub.ts (vitest.config.ts).

const never = () => new Promise<never>(() => {});
const r2Object = (bytes: number[]) => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer });

// An R2 bucket whose get() answers from `answers`, one per call.
function bucket(answers: Array<() => Promise<unknown>>) {
  let call = 0;
  return { get: vi.fn(() => answers[Math.min(call++, answers.length - 1)]()) } as unknown as R2Bucket & { get: ReturnType<typeof vi.fn> };
}

// Settles `promise` within `ms` of fake time, or reports it as still pending.
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'PENDING' | { error: string }> {
  let outcome: T | 'PENDING' | { error: string } = 'PENDING';
  promise.then((v) => { outcome = v; }, (e: Error) => { outcome = { error: e.message }; });
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  createRasterizer.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getSatoshiFont', () => {
  it("does not wait on another request's load that never settles", async () => {
    const { getSatoshiFont } = await import('../src/services/font');
    const r2 = bucket([never, async () => r2Object([1, 2, 3])]);

    const cancelled = getSatoshiFont(r2); // its R2 read never settles
    const next = await within(getSatoshiFont(r2), 100);

    expect(next).toMatchObject({ base64: 'AQID' });
    expect(await within(cancelled, 100)).toBe('PENDING');
    // Loaded once, it is served from memory.
    expect(await within(getSatoshiFont(r2), 0)).toMatchObject({ base64: 'AQID' });
    expect(r2.get).toHaveBeenCalledTimes(2);
  });
});

describe('RasterizeService', () => {
  const renderer = { render: async () => new Uint8Array([0x89, 0x50]) };

  it('retries a failed init on the next request instead of caching the failure', async () => {
    const { RasterizeService } = await import('../src/services/rasterize');
    createRasterizer.mockRejectedValueOnce(new Error('R2 hiccup')).mockResolvedValue(renderer);
    const r2 = bucket([async () => r2Object([0])]);
    const svc = new RasterizeService();

    expect(await within(svc.rasterize('<svg/>', r2), 100)).toEqual({ error: 'R2 hiccup' });
    expect(await within(svc.rasterize('<svg/>', r2), 100)).toEqual(new Uint8Array([0x89, 0x50]));
    expect(createRasterizer).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight init between concurrent requests', async () => {
    const { RasterizeService } = await import('../src/services/rasterize');
    createRasterizer.mockResolvedValue(renderer);
    const r2 = bucket([async () => r2Object([0])]);
    const svc = new RasterizeService();

    const both = await within(Promise.all([svc.rasterize('<svg/>', r2), svc.rasterize('<svg/>', r2)]), 100);

    expect(both).toHaveLength(2);
    expect(createRasterizer).toHaveBeenCalledTimes(1);
  });

  it('stops waiting on an init that never settles, and the next request starts a fresh one', async () => {
    const { RasterizeService, RASTERIZER_INIT_WAIT_MS } = await import('../src/services/rasterize');
    createRasterizer.mockResolvedValue(renderer);
    // The first init's R2 reads never settle (its request was cancelled).
    let hung = true;
    const r2 = { get: vi.fn(() => (hung ? never() : Promise.resolve(r2Object([0])))) } as unknown as R2Bucket;
    const svc = new RasterizeService();

    const first = svc.rasterize('<svg/>', r2).catch((e: Error) => e.message);
    const waiter = await within(svc.rasterize('<svg/>', r2), RASTERIZER_INIT_WAIT_MS + 50);
    expect(waiter).toEqual({ error: `Rasterizer init did not finish within ${RASTERIZER_INIT_WAIT_MS} ms` });

    hung = false;
    expect(await within(svc.rasterize('<svg/>', r2), 100)).toEqual(new Uint8Array([0x89, 0x50]));
    expect(createRasterizer).toHaveBeenCalledTimes(1);
    // The request that started the stuck init gives up too.
    expect(await first).toBe(`Rasterizer init did not finish within ${RASTERIZER_INIT_WAIT_MS} ms`);
  });
});
