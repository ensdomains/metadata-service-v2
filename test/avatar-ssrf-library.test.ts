import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { AvatarService } from '../src/services/avatar';
import { BlockchainService } from '../src/services/blockchain';
import { guardedCcipRequest, MAX_CCIP_RESPONSE_BYTES } from '../src/services/ccip-request';
import { createGuardedFetcher, fetchMediaUrl, BlockedMediaUrlError } from '../src/services/media-fetch';

// SSRF follow-ups (WEB-1550), found by an adversarial review of the first fix:
//  - the ens-avatar resolvers' OWN requests (record JSON, NFT metadata, HEAD)
//    used the library fetcher: hostnames compared verbatim (`host..`,
//    `localhost.` passed), no timeout once headers arrived, unbounded JSON body;
//  - CCIP-read gateway URLs (chosen by whoever deployed a resolver or NFT
//    contract) were fetched by viem's default request with a bare fetch().

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

// A real AvatarService whose resolver reads records from a fake chain client,
// so every HTTP request is made by the library through the service's fetcher.
function serviceWithRecord(record: string, maxAvatarBytes?: number): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', mainnet, maxAvatarBytes);
  const resolver = (svc as unknown as { resolver: { client: unknown } }).resolver;
  resolver.client = {
    getEnsRecord: async () => ({ record, address: null }),
    readContract: async () => null,
  };
  return svc;
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response) {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(`${init?.method ?? 'GET'} ${url}`);
    return handler(url, init);
  }));
  return requested;
}

describe('the ens-avatar resolvers use the guarded fetcher', () => {
  it('is installed on every resolver', () => {
    const svc = new AvatarService('https://rpc.invalid', mainnet, undefined, '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe');
    const { resolver, legacyResolver } = svc as unknown as Record<string, { fetcher: unknown }>;
    expect(resolver.fetcher).toBe(legacyResolver.fetcher);
    expect(Object.keys(resolver.fetcher as object).sort()).toEqual(['get', 'getArrayBuffer', 'head']);
  });

  it.each([
    'https://metadata.ens.domains../mainnet/avatar/x.eth',
    'https://ens-metadata-v2.ensdomains.workers.dev../x',
    'http://localhost./meta.json',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://127.0.0.1../meta.json',
  ])('blocks the library hop to %s without a request', async (record) => {
    quiet();
    const requested = recordingFetch(() => new Response('{}'));
    expect(await serviceWithRecord(record).getAvatarImage('x.eth')).toBeNull();
    expect(requested).toEqual([]);
  });

  it('caps the library JSON read at 2 MiB, whatever the avatar size cap, and stops pulling the stream', async () => {
    quiet();
    let pulledBytes = 0;
    recordingFetch((_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          n++;
          if (n === 1) { c.enqueue(new TextEncoder().encode('{"image":"https://cdn.example/a.png"')); return; }
          if (n > 400) { c.close(); return; } // ~25 MiB offered
          pulledBytes += 64 * 1024;
          c.enqueue(new Uint8Array(64 * 1024).fill(0x20)); // JSON whitespace
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    // A 25 MiB avatar cap (the production default) must not become the JSON cap.
    expect(await serviceWithRecord('https://attacker.example/meta.json', 25 * 1024 * 1024).getAvatarImage('x.eth')).toBeNull();
    expect(pulledBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 2 * 64 * 1024);
  });

  it('guards the JSON-indirection target end to end', async () => {
    quiet();
    const requested = recordingFetch((url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === 'https://attacker.example/meta.json') return new Response(JSON.stringify({ image: 'http://169.254.169.254/latest/meta-data/' }));
      return new Response(PNG);
    });
    expect(await serviceWithRecord('https://attacker.example/meta.json').getAvatarImage('x.eth')).toBeNull();
    expect(requested.some((r) => r.includes('169.254.169.254'))).toBe(false);
  });

  it('still loads an ordinary URI avatar', async () => {
    recordingFetch((_url, init) =>
      init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    expect(await serviceWithRecord('https://cdn.example/a.png').getAvatarImage('ok.eth')).not.toBeNull();
  });

  it('refuses an NFT/URI avatar hosted on this service itself (v1 parity, anti-recursion)', async () => {
    quiet();
    const requested = recordingFetch(() => new Response(PNG));
    // e.g. an ENS NameWrapper NFT, whose image URL is this service's own /image route
    const img = await serviceWithRecord('https://metadata.ens.domains/mainnet/0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401/1/image').getAvatarImage('x.eth');
    expect(img).toBeNull();
    expect(requested).toEqual([]);
  });
});

describe('createGuardedFetcher', () => {
  it('head() and getArrayBuffer() go through the hop checks', async () => {
    const requested = recordingFetch(() => new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } }));
    const f = createGuardedFetcher(8_000, 1024);
    await expect(f.head('https://cdn.example/a')).rejects.toBeInstanceOf(BlockedMediaUrlError);
    await expect(f.getArrayBuffer('https://cdn.example/a')).rejects.toBeInstanceOf(BlockedMediaUrlError);
    expect(requested.every((r) => r.includes('cdn.example'))).toBe(true);
  });

  it('getArrayBuffer() returns only the first bytes', async () => {
    recordingFetch(() => new Response(new Uint8Array(1_000_000)));
    const res = await createGuardedFetcher(8_000, 1024).getArrayBuffer('https://cdn.example/a');
    expect(res.data.byteLength).toBe(1024);
  });

  // The body as `chunks`, each filled with its index, counting the chunks pulled.
  function chunkedBody(chunks: number[]) {
    const counter = { pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = chunks[counter.pulled];
        if (size === undefined) return controller.close();
        controller.enqueue(new Uint8Array(size).fill(counter.pulled + 1));
        counter.pulled++;
      },
    });
    return { body, counter };
  }

  it.each([
    ['one chunk far larger than the prefix', [4 * 1024 * 1024], 1024],
    ['chunks that straddle the prefix end', [300, 300, 300, 300, 300], 1024],
    ['a body shorter than the prefix', [100, 200], 300],
  ])('getArrayBuffer() copies exactly the prefix from %s', async (_, chunks, expected) => {
    const { body, counter } = chunkedBody(chunks);
    recordingFetch(() => new Response(body));
    const res = await createGuardedFetcher(8_000, 1024).getArrayBuffer('https://cdn.example/a');

    const bytes = new Uint8Array(res.data);
    expect(bytes.byteLength).toBe(expected);
    // Byte i comes from the chunk that held it.
    let offset = 0;
    chunks.forEach((size, index) => {
      for (let i = offset; i < Math.min(offset + size, expected); i++) expect(bytes[i]).toBe(index + 1);
      offset += size;
    });
    // Nothing is pulled once the prefix is full.
    expect(counter.pulled).toBeLessThanOrEqual(Math.ceil(1024 / Math.min(...chunks)) + 1);
  });
});

describe('fetchMediaUrl redirect method semantics', () => {
  it('a 302 after POST continues as GET without a body; a 307 repeats the POST', async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, body: init?.body });
      if (url === 'https://gw.example/a') return new Response(null, { status: 302, headers: { Location: '/b' } });
      if (url === 'https://gw.example/c') return new Response(null, { status: 307, headers: { Location: '/d' } });
      return new Response('0x');
    }));
    await fetchMediaUrl('https://gw.example/a', { method: 'POST', body: '{}' });
    await fetchMediaUrl('https://gw.example/c', { method: 'POST', body: '{}' });
    expect(seen).toEqual([
      { url: 'https://gw.example/a', method: 'POST', body: '{}' },
      { url: 'https://gw.example/b', method: 'GET', body: undefined },
      { url: 'https://gw.example/c', method: 'POST', body: '{}' },
      { url: 'https://gw.example/d', method: 'POST', body: '{}' },
    ]);
  });
});

describe('guardedCcipRequest', () => {
  const sender = '0x1111111111111111111111111111111111111111';

  it('never requests private or self gateway URLs, and falls through to a public one', async () => {
    const requested = recordingFetch(() => new Response(JSON.stringify({ data: '0xabcd' }), { headers: { 'content-type': 'application/json' } }));
    const result = await guardedCcipRequest({
      data: '0x1234',
      sender,
      urls: [
        'http://169.254.169.254/latest/meta-data/{data}',
        'https://metadata.ens.domains/mainnet/avatar/attacker.eth?{data}',
        'https://gateway.example/{sender}/{data}.json',
      ],
    });
    expect(result).toBe('0xabcd');
    expect(requested).toEqual([`GET https://gateway.example/${sender}/0x1234.json`]);
  });

  it('POSTs {data, sender} when the URL has no {data} placeholder', async () => {
    let posted: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      posted = { method: init?.method, body: JSON.parse(String(init?.body)) };
      return new Response('0xbeef');
    }));
    expect(await guardedCcipRequest({ data: '0x12', sender, urls: ['https://gateway.example/lookup'] })).toBe('0xbeef');
    expect(posted).toEqual({ method: 'POST', body: { data: '0x12', sender } });
  });

  it('rejects a redirect to a private host and an oversized response', async () => {
    recordingFetch((url) =>
      url.startsWith('https://redirect.example')
        ? new Response(null, { status: 307, headers: { Location: 'http://127.0.0.1/' } })
        : new Response(new Uint8Array(MAX_CCIP_RESPONSE_BYTES + 1)),
    );
    await expect(guardedCcipRequest({ data: '0x12', sender, urls: ['https://redirect.example/{data}'] })).rejects.toThrow();
    await expect(guardedCcipRequest({ data: '0x12', sender, urls: ['https://big.example/{data}'] })).rejects.toThrow();
  });

  it('is the CCIP request of every viem client the service builds', () => {
    const chain = new BlockchainService({ MAINNET_RPC_URL: 'https://rpc.invalid', SEPOLIA_RPC_URL: 'https://rpc.invalid' });
    for (const client of chain.getAllClients('mainnet')) {
      expect((client as unknown as { ccipRead?: { request?: unknown } }).ccipRead?.request).toBe(guardedCcipRequest);
    }
  });

  it('end to end: an OffchainLookup during avatar resolution cannot reach private or self gateways', async () => {
    quiet();
    const ur = mainnet.contracts.ensUniversalResolver.address;
    const revert = encodeErrorResult({
      abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
      errorName: 'OffchainLookup',
      args: [ur, ['http://169.254.169.254/latest/meta-data/{data}', 'https://metadata.ens.domains/mainnet/avatar/attacker.eth?{data}'], '0x1234', '0x12345678', '0x'],
    });
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://rpc.example')) {
        const body = JSON.parse(String(init?.body));
        const reply = (b: { id: number }) => ({ jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted', data: revert } });
        return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { 'content-type': 'application/json' } });
      }
      requested.push(url);
      return new Response('not hex');
    }));
    const img = await new AvatarService('https://rpc.example/', mainnet).getAvatarImage('attacker.eth');
    expect(img).toBeNull();
    expect(requested).toEqual([]);
  });
});
