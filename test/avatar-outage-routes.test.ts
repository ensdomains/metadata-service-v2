import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpRequestError } from 'viem';
import { AvatarResolver } from '@ensdomains/ens-avatar';
import { createMockEnv } from './mocks/hono-env';

// Route-level outage handling for avatar lookups. A failed lookup (RPC, CCIP
// gateway or media host outage, timeout) used to read as "no avatar": /avatar
// and /header answered 404, and the NFT card was rendered without the avatar,
// written to KV and R2 and the edge cache, and sent with the full card TTL.
// Now /avatar, /header and /avatar/:name/meta answer 503 with a short
// Cache-Control, and a card missing a failed avatar is kept out of KV and R2
// and cached for a minute only (by clients and the edge). Genuine misses are
// unchanged.

// ---- fake caches.default (per-colo L0 edge cache) -----------------------------
const edgeStore = new Map<string, Response>();
const keyOf = (r: RequestInfo | URL) => (typeof r === 'string' ? r : r instanceof URL ? r.href : r.url);
(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match(req: RequestInfo | URL) {
      return edgeStore.get(keyOf(req))?.clone();
    },
    async put(req: RequestInfo | URL, res: Response) {
      edgeStore.set(keyOf(req), res);
    },
    async delete(req: RequestInfo | URL) {
      return edgeStore.delete(keyOf(req));
    },
  },
};

// WASM imports break under vite-node (mirrors test/index.test.ts).
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));
// The real ImageGenerationService runs (including its own avatar lookup);
// only the layout engine and the R2 font are faked.
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn(async (opts: { backgroundImageUrl: string | null }) =>
    new TextEncoder().encode(`<svg data-avatar="${opts.backgroundImageUrl ? 'yes' : 'no'}"/>`),
  ),
  initializeFont: vi.fn(async () => {}),
}));
vi.mock('../src/services/font', () => ({
  getSatoshiFont: vi.fn(async () => ({ buffer: new ArrayBuffer(0), base64: '' })),
}));

import { MetadataService } from '../src/services/metadata';
import { AvatarService } from '../src/services/avatar';
import { WebhookService } from '../src/services/webhook';
import { MIGRATION_STATUS } from '../src/types';
import app from '../src/index';

vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
vi.spyOn(MetadataService.prototype, 'resolveStatusForImage').mockResolvedValue(MIGRATION_STATUS.MIGRATED);
vi.spyOn(MetadataService.prototype, 'recordMigrationStatus').mockResolvedValue(undefined);
vi.spyOn(WebhookService.prototype, 'handleWebhook').mockImplementation(
  async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
);
// These cards are unthemed: only the avatar lookup is under test.
vi.spyOn(AvatarService.prototype, 'getTextRecord').mockResolvedValue(null);
const getAvatar = vi.spyOn(AvatarResolver.prototype, 'getAvatar');
const getHeader = vi.spyOn(AvatarResolver.prototype, 'getHeader');
const getMetadata = vi.spyOn(AvatarResolver.prototype, 'getMetadata');

// One env for the whole file: the app keeps its per-network services (and the
// KV/R2 bindings they were built with) for the isolate's lifetime.
const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' };
const envArg = env as unknown as Record<string, unknown>;

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

// Send a request; with fake timers, advance the clock by `advanceMs` while it runs.
async function send(path: string, init?: RequestInit, advanceMs = 0) {
  const { ctx, flush } = makeCtx();
  const pending = app.request(path, init, envArg, ctx);
  if (advanceMs) await vi.advanceTimersByTimeAsync(advanceMs);
  const res = await pending;
  await flush();
  return res;
}

const hang = () => new Promise<never>(() => {});
const rpcDown = () => new HttpRequestError({ url: 'https://mainnet.test.rpc', status: 503 });
const cardWrites = () => ({
  kv: vi.mocked(env.SVG_CACHE.put).mock.calls.length,
  r2: vi.mocked(env.ASSET_BUCKET.put).mock.calls.length,
});

beforeEach(() => {
  vi.clearAllMocks();
  edgeStore.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/avatar, /header, /avatar/:name/meta', () => {
  it('a lookup that times out answers 503 with a short Cache-Control, not 404', async () => {
    vi.useFakeTimers();
    getAvatar.mockImplementation(hang);
    getHeader.mockImplementation(hang);
    getMetadata.mockImplementation(hang);

    const avatar = await send('/mainnet/avatar/slow.eth', undefined, 8_000);
    const header = await send('/mainnet/header/slow.eth', undefined, 8_000);
    const meta = await send('/mainnet/avatar/slow.eth/meta', undefined, 8_000);

    for (const res of [avatar, header, meta]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    }
    expect(edgeStore.size).toBe(0);
  });

  it('a genuine miss still answers 404; an RPC failure answers 503', async () => {
    getAvatar.mockResolvedValueOnce(null).mockRejectedValueOnce(rpcDown());
    const miss = await send('/mainnet/avatar/none.eth');
    const failed = await send('/mainnet/avatar/none.eth');
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { message: string }).message).toBe('No avatar set for none.eth');
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Cache-Control')).toBe('public, max-age=30');

    getMetadata.mockResolvedValueOnce(null).mockRejectedValueOnce(rpcDown());
    const metaMiss = await send('/mainnet/avatar/none.eth/meta');
    const metaFailed = await send('/mainnet/avatar/none.eth/meta');
    expect(metaMiss.status).toBe(404);
    expect(metaFailed.status).toBe(503);
  });
});

describe('NFT card routes', () => {
  it('/image: an avatar lookup that times out gives a card kept out of KV/R2 and cached for a minute only, by clients and the edge', async () => {
    vi.useFakeTimers();
    getAvatar.mockImplementation(hang);

    const res = await send('/mainnet/registry/slow.eth/image', undefined, 20_000);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<svg data-avatar="no"/>');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(cardWrites()).toEqual({ kv: 0, r2: 0 });
    expect(edgeStore.get('http://localhost/mainnet/registry/slow.eth/image')?.headers.get('Cache-Control')).toBe('public, max-age=60');
    // Looked up once: the image service does not repeat the failed lookup.
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });

  it('/image: a name with no avatar gets its card cached as before, after a single lookup', async () => {
    getAvatar.mockResolvedValue(null);

    const res = await send('/mainnet/registry/none.eth/image');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=21600, stale-while-revalidate=64800');
    expect(cardWrites()).toEqual({ kv: 1, r2: 1 });
    expect(edgeStore.has('http://localhost/mainnet/registry/none.eth/image')).toBe(true);
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });

  it('/rasterize: a card whose avatar lookup failed is kept out of KV/R2 and cached for a minute only, by clients and the edge', async () => {
    getAvatar.mockRejectedValue(rpcDown());

    const res = await send('/mainnet/registry/down.eth/rasterize');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(cardWrites()).toEqual({ kv: 0, r2: 0 });
    expect(edgeStore.get('http://localhost/mainnet/registry/down.eth/rasterize')?.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('/image: during an outage the degraded card is served from the edge, so the failing upstream is not asked again', async () => {
    getAvatar.mockRejectedValue(rpcDown());

    const first = await send('/mainnet/registry/down.eth/image');
    const second = await send('/mainnet/registry/down.eth/image');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.text());
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });

  it('webhook warming does not persist a card whose avatar lookup failed', async () => {
    getAvatar.mockRejectedValue(rpcDown());

    const res = await send('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'down.eth', protocol: 'v1', type: 'update' }),
    });

    expect(res.status).toBe(200);
    // Both networks were warmed (mainnet, and sepolia with its legacy resolver)...
    expect(getAvatar.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ...and neither stored a card, nor claims it did.
    expect(cardWrites()).toEqual({ kv: 0, r2: 0 });
    const logged = vi.mocked(console.log).mock.calls.map((args) => String(args[0]));
    expect(logged.filter((line) => line.startsWith('[webhook] warmed image cache'))).toEqual([]);
    expect(logged.filter((line) => line.includes('avatar lookup failed'))).toHaveLength(2);
  });
});
