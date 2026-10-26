import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Mock rasterize (WASM) — importing ../src/index pulls the whole worker graph.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class { async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); } },
}));

import { MetadataService } from '../src/services/metadata';
import { MetadataCacheService } from '../src/services/metadata-cache';
import app from '../src/index';

// WEB-1552: POST /batch-metadata resolved every entry at once (up to 100),
// invalid and duplicate names included, with no time bound: during an indexer
// outage one request fanned out to every fallback path at once.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function batch(body: unknown, env: Record<string, unknown> = {}) {
  return app.request(
    '/batch-metadata',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) },
    { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true', ...env } as unknown as Record<string, unknown>,
    ctx,
  );
}

type BatchBody = {
  results: Array<{ name: string; metadata?: { name: string }; error?: string }>;
  total: number;
  successful: number;
  failed: number;
};

const metadataFor = (name: string) => ({ name, description: `${name}, an ENS name.`, attributes: [] });
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let checkExpiry: MockInstance<MetadataService['checkExpiry']>;
let getMetadata: MockInstance<MetadataService['getMetadata']>;
let cacheGet: MockInstance<MetadataCacheService['get']>;

beforeEach(() => {
  checkExpiry = vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
  getMetadata = vi.spyOn(MetadataService.prototype, 'getMetadata')
    .mockImplementation(async (_network, _registryType, name) => metadataFor(name) as never);
  // Calls through: the KV mock always misses, so every resolution reaches getMetadata.
  cacheGet = vi.spyOn(MetadataCacheService.prototype, 'get');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /batch-metadata limits', () => {
  it('resolves each distinct name once and shares the result with its duplicates', async () => {
    const names = ['Nick.eth', 'nick.eth', 'vitalik.eth', 'NICK.ETH', 'vitalik.eth'];
    const res = await batch({ names });
    expect(res.status).toBe(200);
    const body = await res.json() as BatchBody;

    expect(getMetadata).toHaveBeenCalledTimes(2);
    expect(checkExpiry).toHaveBeenCalledTimes(2);
    expect(getMetadata.mock.calls.map((call) => call[2]).sort()).toEqual(['nick.eth', 'vitalik.eth']);

    // Every entry gets a result, echoing its name as given.
    expect(body.results.map((r) => r.name)).toEqual(names);
    expect(body.results.map((r) => r.metadata?.name)).toEqual(['nick.eth', 'nick.eth', 'vitalik.eth', 'nick.eth', 'vitalik.eth']);
    expect(body).toMatchObject({ total: 5, successful: 5, failed: 0 });
  });

  it('resolves ENSIP-15-equivalent spellings once, under the canonical name (SEC-NAME-001)', async () => {
    const names = ['nick.eth', 'ｎｉｃｋ.eth', 'ni\u200Bck.eth', '❤️.eth', '❤.eth'];
    const res = await batch({ names });
    expect(res.status).toBe(200);
    const body = await res.json() as BatchBody;

    expect(getMetadata.mock.calls.map((call) => call[2]).sort()).toEqual(['nick.eth', '❤.eth'].sort());
    expect(checkExpiry).toHaveBeenCalledTimes(2);
    expect(body.results.map((r) => r.name)).toEqual(names);
  });

  it('answers invalid names without resolving them', async () => {
    const names = ['nick.eth', 'nodot', 'a..eth', '', `${'a'.repeat(300)}.eth`];
    const res = await batch({ names });
    expect(res.status).toBe(200);
    const body = await res.json() as BatchBody;

    expect(body.results).toEqual([
      { name: 'nick.eth', metadata: metadataFor('nick.eth') },
      { name: 'nodot', error: 'Invalid ENS name format' },
      { name: 'a..eth', error: 'Invalid ENS name format' },
      { name: '', error: 'Invalid ENS name format' },
      { name: `${'a'.repeat(300)}.eth`, error: 'Invalid ENS name format' },
    ]);
    expect(body).toMatchObject({ total: 5, successful: 1, failed: 4 });
    // Only the valid name touched the expiry gate, the cache or the resolver.
    expect(checkExpiry.mock.calls.map((call) => call[0])).toEqual(['nick.eth']);
    expect(cacheGet.mock.calls.map((call) => call[2])).toEqual(['nick.eth']);
    expect(getMetadata.mock.calls.map((call) => call[2])).toEqual(['nick.eth']);
  });

  it('keeps the input order across duplicates, invalid names and out-of-order resolutions', async () => {
    // Lower-numbered names take longer, so resolutions finish out of order.
    getMetadata.mockImplementation(async (_network, _registryType, name) => {
      await tick(2 * (10 - Number(name.match(/\d/)![0])));
      return metadataFor(name) as never;
    });
    const names = ['name5.eth', 'bad', 'NAME1.eth', 'name3.eth', 'name1.eth', '', 'name0.eth', 'Name5.eth'];
    const body = await (await batch({ names })).json() as BatchBody;

    expect(getMetadata).toHaveBeenCalledTimes(4);
    expect(body.results).toEqual([
      { name: 'name5.eth', metadata: metadataFor('name5.eth') },
      { name: 'bad', error: 'Invalid ENS name format' },
      { name: 'NAME1.eth', metadata: metadataFor('name1.eth') },
      { name: 'name3.eth', metadata: metadataFor('name3.eth') },
      { name: 'name1.eth', metadata: metadataFor('name1.eth') },
      { name: '', error: 'Invalid ENS name format' },
      { name: 'name0.eth', metadata: metadataFor('name0.eth') },
      { name: 'Name5.eth', metadata: metadataFor('name5.eth') },
    ]);
  });

  it('resolves at most 6 names at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    checkExpiry.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
    });
    getMetadata.mockImplementation(async (_network, _registryType, name) => {
      await tick(5);
      inFlight--;
      return metadataFor(name) as never;
    });

    const names = Array.from({ length: 25 }, (_, i) => `name${i}.eth`);
    const body = await (await batch({ names })).json() as BatchBody;
    expect(body.successful).toBe(25);
    expect(maxInFlight).toBe(6);
  });

  it('bounds the background refreshes of stale entries by the same limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let done = 0;
    getMetadata.mockImplementation(async (_network, _registryType, name) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight--;
      done++;
      return metadataFor(name) as never;
    });
    // Every entry is stale: served at once and refreshed in the background.
    cacheGet.mockImplementation(async (_network, _registryType, name, _ctx, fetchMetadata) => {
      void fetchMetadata();
      return { metadata: metadataFor(name), cacheStatus: 'stale' } as never;
    });

    const names = Array.from({ length: 30 }, (_, i) => `name${i}.eth`);
    const body = await (await batch({ names })).json() as BatchBody;
    expect(body.successful).toBe(30);
    while (done < 30) await tick(5);
    expect(maxInFlight).toBe(6);
  });

  it('caps a batch at 100 names by default', async () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `name${i}.eth`);

    const over = await batch({ names: names(101) });
    expect(over.status).toBe(400);
    expect((await over.json() as { error: string }).error).toBe('Cannot process more than 100 names at once');
    expect(checkExpiry).not.toHaveBeenCalled();

    const atCap = await batch({ names: names(100) });
    expect(atCap.status).toBe(200);
  });

  it('counts duplicate and invalid entries against the cap', async () => {
    const res = await batch({ names: Array.from({ length: 101 }, (_, i) => (i % 2 ? 'nick.eth' : 'bad')) });
    expect(res.status).toBe(400);
  });

  it('rejects an entry whose lowercase form is too long, as given, without resolving it', async () => {
    // 'İ' lowercases to two code units: 204 characters as sent, 404 as resolved.
    const long = `${'İ'.repeat(200)}.eth`;
    const body = await (await batch({ names: [long, 'nick.eth'] })).json() as BatchBody;
    expect(body.results[0]).toEqual({ name: long, error: 'Invalid ENS name format' });
    expect(getMetadata).toHaveBeenCalledTimes(1);
  });

  it('takes the cap from MAX_BATCH_NAMES, ignoring a value that is not a positive integer', async () => {
    const names = ['a.eth', 'b.eth', 'c.eth', 'd.eth'];
    expect((await batch({ names }, { MAX_BATCH_NAMES: '3' })).status).toBe(400);
    expect((await batch({ names }, { MAX_BATCH_NAMES: '4' })).status).toBe(200);
    expect((await batch({ names }, { MAX_BATCH_NAMES: 'lots' })).status).toBe(200);
    expect((await batch({ names }, { MAX_BATCH_NAMES: '0' })).status).toBe(200);
  });

  it('answers names not started within the time budget instead of resolving them', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // The first resolution to finish takes the batch past its 15s budget.
    getMetadata.mockImplementation(async (_network, _registryType, name) => {
      clock += 16_000;
      return metadataFor(name) as never;
    });

    const names = Array.from({ length: 12 }, (_, i) => `name${i}.eth`);
    const res = await batch({ names });
    expect(res.status).toBe(200);
    const body = await res.json() as BatchBody;

    // The 6 names already in flight complete; the 6 still queued are not started.
    expect(getMetadata).toHaveBeenCalledTimes(6);
    expect(body.results.slice(0, 6).every((r) => r.metadata)).toBe(true);
    expect(body.results.slice(6)).toEqual(
      Array.from({ length: 6 }, (_, i) => ({ name: `name${i + 6}.eth`, error: 'Batch time budget exceeded' })),
    );
    expect(body).toMatchObject({ total: 12, successful: 6, failed: 6 });
  });

  it('reports a failed resolution per entry, naming the entry as given', async () => {
    getMetadata.mockRejectedValue(new Error('boom'));
    const body = await (await batch({ names: ['Nick.eth', 'nick.eth'] })).json() as BatchBody;
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([
      { name: 'Nick.eth', error: 'Failed to resolve Nick.eth' },
      { name: 'nick.eth', error: 'Failed to resolve nick.eth' },
    ]);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await batch('{"names": [');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("Request body must contain 'names' array");
  });
});
