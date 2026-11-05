import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest';
import { HttpRequestError } from 'viem';
import { mainnet } from 'viem/chains';
import { AvatarService, MEDIA_FAILURE_TTL_SECS } from '../src/services/avatar';
import {
  MEDIA_HOST_PAUSE_MS,
  createGuardedFetcher,
  fetchMediaUrl,
  resetMediaHostPauses,
} from '../src/services/media-fetch';
import { RequestDeadlineError, UpstreamError } from '../src/services/errors';

// Backoff from avatar hosts that throttle or fail (WEB-2076). A degraded card
// is never cached, so a popular name whose avatar host answered 429 or 530 was
// looked up again on every request: another request for the throttling host,
// up to 8s of waiting, and one Cloudflare issue per name. Now a failed lookup
// is remembered per name for MEDIA_FAILURE_TTL_SECS, a host that answered 429
// is left alone for MEDIA_HOST_PAUSE_MS, and the failures name the host.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RPC = 'https://rpc.example/';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMediaHostPauses();
});

function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

function memoryKv() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
  return { store, kv };
}

type FakeResolver = { getAvatar?: Mock; getHeader?: Mock; getMetadata?: Mock };

// A real AvatarService with fake resolvers (nothing leaves the process).
function makeService(primary: FakeResolver, failureCache?: KVNamespace): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', mainnet, undefined, undefined, undefined, failureCache);
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = undefined;
  return svc;
}

const rpcDown = () => new HttpRequestError({ url: RPC, status: 503 });

describe('a failed lookup is remembered per name', () => {
  it('is not run again within the TTL: the remembered failure is thrown instead', async () => {
    quiet();
    const { kv } = memoryKv();
    const getAvatar = vi.fn().mockRejectedValue(rpcDown());
    const svc = makeService({ getAvatar }, kv);

    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(kv.put).toHaveBeenCalledWith(
      'media-failure:1:avatar:nick.eth',
      'avatar resolution failed',
      { expirationTtl: MEDIA_FAILURE_TTL_SECS },
    );

    await expect(svc.getAvatarImage('nick.eth')).rejects.toThrow(/failed recently: avatar resolution failed/);
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });

  it('keeps the avatar, header and avatar-metadata lookups apart', async () => {
    quiet();
    const { kv, store } = memoryKv();
    const svc = makeService(
      {
        getAvatar: vi.fn().mockRejectedValue(rpcDown()),
        getHeader: vi.fn().mockRejectedValue(rpcDown()),
        getMetadata: vi.fn().mockRejectedValue(rpcDown()),
      },
      kv,
    );
    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    await expect(svc.getHeaderImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    await expect(svc.getAvatarMeta('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect([...store.keys()].sort()).toEqual([
      'media-failure:1:avatar metadata:nick.eth',
      'media-failure:1:avatar:nick.eth',
      'media-failure:1:header:nick.eth',
    ]);
  });

  it('remembers neither a miss nor a value', async () => {
    quiet();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200 })));
    const { kv } = memoryKv();
    const getAvatar = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('https://cdn.example/a.png');
    const svc = makeService({ getAvatar }, kv);

    expect(await svc.getAvatarImage('nick.eth')).toBeNull();
    expect(await svc.getAvatarImage('nick.eth')).not.toBeNull();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("does not remember a failure caused by this request's own deadline", async () => {
    quiet();
    const { kv } = memoryKv();
    const getAvatar = vi.fn().mockRejectedValue(new RequestDeadlineError('request deadline reached'));
    const svc = makeService({ getAvatar }, kv);

    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(RequestDeadlineError);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('runs the lookup when the cache cannot be read or written', async () => {
    quiet();
    const kv = {
      get: vi.fn().mockRejectedValue(new Error('KV GET failed')),
      put: vi.fn().mockRejectedValue(new Error('KV PUT failed')),
    } as unknown as KVNamespace;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200 })));
    const getAvatar = vi.fn().mockRejectedValueOnce(rpcDown()).mockResolvedValueOnce('https://cdn.example/a.png');
    const svc = makeService({ getAvatar }, kv);

    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(await svc.getAvatarImage('nick.eth')).not.toBeNull();
    expect(getAvatar).toHaveBeenCalledTimes(2);
  });

  it('runs every lookup when there is no cache', async () => {
    quiet();
    const getAvatar = vi.fn().mockRejectedValue(rpcDown());
    const svc = makeService({ getAvatar });

    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(getAvatar).toHaveBeenCalledTimes(2);
  });
});

describe('a host that answered 429 is paused', () => {
  function stubFetch(statusByHost: Record<string, number>) {
    const fetchMock = vi.fn(async (url: string) => new Response('x', { status: statusByHost[new URL(url).hostname] ?? 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    quiet();
  });

  it('is not asked again within the pause, while other hosts are', async () => {
    const fetchMock = stubFetch({ 'throttled.example': 429 });

    expect((await fetchMediaUrl('https://throttled.example/a.png')).status).toBe(429);
    await expect(fetchMediaUrl('https://throttled.example/b.png')).rejects.toThrow(
      new UpstreamError(`media host throttled.example answered 429 within the last ${MEDIA_HOST_PAUSE_MS / 1000}s, not asked again`),
    );
    expect((await fetchMediaUrl('https://other.example/a.png')).status).toBe(200);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://throttled.example/a.png',
      'https://other.example/a.png',
    ]);
  });

  it('is asked again once the pause is over', async () => {
    const fetchMock = stubFetch({ 'throttled.example': 429 });

    await fetchMediaUrl('https://throttled.example/a.png');
    vi.advanceTimersByTime(MEDIA_HOST_PAUSE_MS + 1);
    expect((await fetchMediaUrl('https://throttled.example/a.png')).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("covers the library's metadata requests and the image fetch alike", async () => {
    const fetchMock = stubFetch({ 'throttled.example': 429 });
    await fetchMediaUrl('https://throttled.example/warmup');

    const fetcher = createGuardedFetcher(1_000, 1024);
    await expect(fetcher.get('https://throttled.example/meta.json')).rejects.toBeInstanceOf(UpstreamError);

    const svc = makeService({ getAvatar: vi.fn().mockResolvedValue('https://throttled.example/a.png') });
    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is not triggered by other failing statuses', async () => {
    const fetchMock = stubFetch({ 'down.example': 530 });

    await fetchMediaUrl('https://down.example/a.png');
    await fetchMediaUrl('https://down.example/a.png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a failure names the host, not the name', () => {
  it('for the image fetch and for the metadata the library fetches', async () => {
    quiet();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 530 })));

    const svc = makeService({ getAvatar: vi.fn().mockResolvedValue('https://cdn.example/a.png') });
    await expect(svc.getAvatarImage('nick.eth')).rejects.toThrow('avatar host cdn.example answered 530');

    const fetcher = createGuardedFetcher(1_000, 1024);
    await expect(fetcher.get('https://meta.example/1.json')).rejects.toThrow('metadata host meta.example answered 530');
  });

  it('is warned without the name and logged with it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = rpcDown();
    const svc = makeService({ getAvatar: vi.fn().mockRejectedValue(error) });

    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(warn).toHaveBeenCalledWith('avatar resolution failed:', error);
    expect(log).toHaveBeenCalledWith('avatar resolution failed for nick.eth:', error);
    expect(warn.mock.calls.some(([line]) => String(line).includes('nick.eth'))).toBe(false);
  });
});
