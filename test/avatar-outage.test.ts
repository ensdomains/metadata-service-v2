import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { UnsupportedNamespace, utils as avatarUtils } from '@ensdomains/ens-avatar';
import { AvatarService } from '../src/services/avatar';
import { BlockedMediaUrlError } from '../src/services/media-fetch';
import { UpstreamError } from '../src/services/errors';

// Outage handling for avatar/header lookups. AvatarService used to turn every
// error and its own 8s timeout into null, so an RPC, CCIP-gateway or media-host
// outage read as "this name has no avatar": the NFT card was cached without it
// for hours and /avatar answered 404. A definitive miss must still be null; a
// failed lookup must throw UpstreamError so nothing caches the absence.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RPC = 'https://rpc.example/';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

type FakeResolver = { getAvatar?: Mock; getHeader?: Mock; getMetadata?: Mock };

// A real AvatarService with fake resolvers (nothing leaves the process).
function makeService(primary: FakeResolver, legacy?: FakeResolver): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', mainnet);
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = legacy;
  return svc;
}

async function outcome(p: Promise<unknown>): Promise<'value' | 'miss' | 'failure' | 'other'> {
  try {
    return (await p) === null ? 'miss' : 'value';
  } catch (e) {
    return e instanceof UpstreamError ? 'failure' : 'other';
  }
}

const urAbi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)',
  'error ResolverNotFound(bytes name)',
  'error HttpError(uint16 status, string message)',
]);
const textAbi = parseAbi(['function text(bytes32 node, string key) view returns (string)']);
const nftAbi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
const TEXT_SELECTOR = toFunctionSelector('text(bytes32,string)');
const TOKEN_URI_SELECTOR = toFunctionSelector('tokenURI(uint256)');
const NFT = '0x1111111111111111111111111111111111111111';
const RESOLVER = '0x2222222222222222222222222222222222222222';

function gatewayRevert(status: number): ContractFunctionExecutionError {
  const data = encodeErrorResult({ abi: urAbi, errorName: 'HttpError', args: [status, 'gateway says no'] });
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: urAbi, data, functionName: 'resolveWithGateways' }),
    { abi: urAbi, args: ['0x', '0x', []], functionName: 'resolveWithGateways' },
  );
}

describe('lookup timeout', () => {
  it.each([
    ['avatar', (svc: AvatarService) => svc.getAvatarImage('slow.eth')],
    ['header', (svc: AvatarService) => svc.getHeaderImage('slow.eth')],
    ['avatar metadata', (svc: AvatarService) => svc.getAvatarMeta('slow.eth')],
  ])('an %s lookup that outlives the 8s budget fails (UpstreamError) instead of reading as "none"', async (_kind, call) => {
    quiet();
    vi.useFakeTimers();
    const hang = () => new Promise(() => {});
    const svc = makeService({ getAvatar: vi.fn(hang), getHeader: vi.fn(hang), getMetadata: vi.fn(hang) });
    const settled = expect(call(svc)).rejects.toBeInstanceOf(UpstreamError);
    await vi.advanceTimersByTimeAsync(8_000);
    await settled;
  });
});

describe('errors thrown by a lookup', () => {
  it.each([
    ['viem HttpRequestError (RPC unreachable or 5xx)', new HttpRequestError({ url: RPC, status: 503 })],
    ['viem TimeoutError', new TimeoutError({ body: {}, url: RPC })],
    ['viem RpcRequestError (rate limited)', new RpcRequestError({ body: {}, error: { code: -32005, message: 'limit exceeded' }, url: RPC })],
    ['a Universal Resolver HttpError(503) revert (CCIP gateway down, hardened library)', gatewayRevert(503)],
    ['a metadata host answering 5xx (guarded fetcher)', new UpstreamError('metadata host answered 503')],
  ])('%s fails the lookup', async (_label, error) => {
    quiet();
    const svc = makeService({ getAvatar: vi.fn().mockRejectedValue(error), getMetadata: vi.fn().mockRejectedValue(error) });
    await expect(svc.getAvatarImage('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
    await expect(svc.getAvatarMeta('nick.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  // The hardened ens-avatar release adds ChainMismatch; alpha.2 does not export it.
  class ChainMismatch extends avatarUtils.BaseError {}
  let nftParseError: unknown;
  try {
    avatarUtils.parseNFT('eip155:1/erc721:0xabc');
  } catch (e) {
    nftParseError = e;
  }

  it.each([
    ['UnsupportedNamespace', new UnsupportedNamespace('Unsupported namespace: erc999')],
    ['MetadataParsingError', new avatarUtils.MetadataParsingError('Failed to parse token metadata')],
    ['ChainMismatch (hardened release)', new ChainMismatch('NFT is on chain 137 but the client reads chain 1')],
    ['NFTURIParsingError', nftParseError],
    ['"Image is not available" (alpha.2 throws the bare string)', 'Image is not available'],
    ['"Image is not available" (hardened release throws a BaseError)', new avatarUtils.BaseError('Image is not available')],
    ['tokenURI unavailable, with no outage seen', new avatarUtils.BaseError('tokenURI is empty or could not be retrieved')],
    ['a body that is not JSON, with no outage seen', new SyntaxError('Unexpected token < in JSON')],
    ['a TypeError on malformed metadata, with no outage seen', new TypeError('uri.startsWith is not a function')],
    ['a blocked URL', new BlockedMediaUrlError('blocked private media host: 10.0.0.1')],
  ])('%s is a miss (null), while an RPC failure in its place fails the lookup', async (_label, error) => {
    quiet();
    const rpcDown = new HttpRequestError({ url: RPC, status: 503 });
    const getAvatar = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(rpcDown);
    const svc = makeService({ getAvatar });
    expect(await outcome(svc.getAvatarImage('nick.eth'))).toBe('miss');
    expect(await outcome(svc.getAvatarImage('nick.eth'))).toBe('failure');
  });
});

describe('legacy-resolver fallback (sepolia: v2 primary, v1 legacy)', () => {
  it('a primary failure is only overridden by a legacy hit, never masked by a legacy null', async () => {
    quiet();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200 })));
    const down = () => vi.fn().mockRejectedValue(new HttpRequestError({ url: RPC, status: 503 }));
    const none = () => vi.fn().mockResolvedValue(null);
    const hit = () => vi.fn().mockResolvedValue('https://cdn.example/a.png');
    const meta = () => vi.fn().mockResolvedValue({ image: 'https://cdn.example/a.png' });

    expect({
      failNull: await outcome(makeService({ getAvatar: down() }, { getAvatar: none() }).getAvatarImage('n.eth')),
      failHit: await outcome(makeService({ getAvatar: down() }, { getAvatar: hit() }).getAvatarImage('n.eth')),
      nullFail: await outcome(makeService({ getAvatar: none() }, { getAvatar: down() }).getAvatarImage('n.eth')),
      nullNull: await outcome(makeService({ getAvatar: none() }, { getAvatar: none() }).getAvatarImage('n.eth')),
      metaFailNull: await outcome(makeService({ getMetadata: down() }, { getMetadata: none() }).getAvatarMeta('n.eth')),
      metaFailHit: await outcome(makeService({ getMetadata: down() }, { getMetadata: meta() }).getAvatarMeta('n.eth')),
    }).toEqual({
      failNull: 'failure',
      failHit: 'value',
      nullFail: 'failure',
      nullNull: 'miss',
      metaFailNull: 'failure',
      metaFailHit: 'value',
    });
  });
});

describe('media fetch', () => {
  const svcFor = (uri: string, maxBytes?: number) => {
    const svc = new AvatarService('https://rpc.invalid', mainnet, maxBytes);
    (svc as unknown as { resolver: FakeResolver }).resolver = { getAvatar: vi.fn().mockResolvedValue(uri) };
    (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = undefined;
    return svc;
  };

  it('a failing or throttling media host fails the lookup; any other status is a miss', async () => {
    quiet();
    const results: Record<number, string> = {};
    for (const status of [403, 404, 410, 408, 429, 500, 502, 503, 504]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));
      results[status] = await outcome(svcFor('https://cdn.example/a.png').getAvatarImage('x.eth'));
    }
    expect(results).toEqual({
      403: 'miss',
      404: 'miss',
      410: 'miss',
      408: 'failure',
      429: 'failure',
      500: 'failure',
      502: 'failure',
      503: 'failure',
      504: 'failure',
    });
  });

  it('a network error or a body cut off mid-read fails the lookup; a blocked URL or an oversized image is a miss', async () => {
    quiet();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const unreachable = await outcome(svcFor('https://cdn.example/a.png').getAvatarImage('x.eth'));

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { c.error(new TypeError('connection reset')); },
    }), { status: 200 })));
    const cutOff = await outcome(svcFor('https://cdn.example/a.png').getAvatarImage('x.eth'));

    const fetchMock = vi.fn(async () => new Response(new Uint8Array(4096), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const blocked = await outcome(svcFor('http://127.0.0.1/a.png').getAvatarImage('x.eth'));
    const oversized = await outcome(svcFor('https://cdn.example/big.png', 1024).getAvatarImage('x.eth'));

    expect({ unreachable, cutOff, blocked, oversized }).toEqual({
      unreachable: 'failure',
      cutOff: 'failure',
      blocked: 'miss',
      oversized: 'miss',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the blocked URL was never requested
  });
});

// The library's own requests go through the guarded fetcher; the errors it
// swallows (its image check reads a failed HEAD as "not an image") are
// reported to the lookup's outage scope.
describe('failures inside the ens-avatar library', () => {
  function serviceWithRecord(record: string, tokenURI?: string): AvatarService {
    const svc = new AvatarService('https://rpc.invalid', mainnet);
    const resolver = (svc as unknown as { resolver: { client: unknown } }).resolver;
    resolver.client = {
      getEnsRecord: async () => ({ record, address: null }),
      readContract: async () => {
        if (tokenURI === undefined) throw new Error('execution reverted');
        return tokenURI;
      },
    };
    return svc;
  }

  function stubHosts(routes: Record<string, (method: string) => Response>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const route = routes[url];
      if (!route) return new Response('not found', { status: 404 });
      return route(init?.method ?? 'GET');
    }));
  }

  const html = () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const status = (s: number) => () => new Response('upstream says no', { status: s });

  it('a URI record that is not an image is a miss; the same URL on a failing host fails the lookup', async () => {
    quiet();
    const page = 'https://host.example/page';
    stubHosts({ [page]: html });
    const notAnImage = await outcome(serviceWithRecord(page).getAvatarImage('x.eth'));

    stubHosts({ [page]: status(503) });
    const hostDown = await outcome(serviceWithRecord(page).getAvatarImage('x.eth'));

    // HEAD fails, then the library falls back to reading the URL as JSON
    // metadata and cannot parse it: the parse error is the outage's echo.
    stubHosts({ [page]: (method) => (method === 'HEAD' ? status(502)() : html()) });
    const flakyHead = await outcome(serviceWithRecord(page).getAvatarImage('x.eth'));

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const unreachable = await outcome(serviceWithRecord(page).getAvatarImage('x.eth'));

    expect({ notAnImage, hostDown, flakyHead, unreachable }).toEqual({
      notAnImage: 'miss',
      hostDown: 'failure',
      flakyHead: 'failure',
      unreachable: 'failure',
    });
  });

  it('an NFT whose image is not an image is a miss; an image host answering 5xx/429 to the image check fails the lookup', async () => {
    quiet();
    const meta = 'https://meta.example/1.json';
    const image = 'https://cdn.example/1.png';
    const record = `eip155:1/erc721:${NFT}/1`;
    const withImageHost = (imageRoute: (method: string) => Response) =>
      stubHosts({
        [meta]: () => new Response(JSON.stringify({ image }), { status: 200, headers: { 'content-type': 'application/json' } }),
        [image]: imageRoute,
      });

    const results: Record<string, string> = {};
    for (const [label, route] of [
      ['text/html', html],
      ['404', status(404)],
      ['503', status(503)],
      ['429', status(429)],
    ] as const) {
      withImageHost(route);
      results[label] = await outcome(serviceWithRecord(record, meta).getAvatarImage('x.eth'));
    }
    withImageHost(() => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
    results.png = await outcome(serviceWithRecord(record, meta).getAvatarImage('x.eth'));

    expect(results).toEqual({ 'text/html': 'miss', 404: 'miss', 503: 'failure', 429: 'failure', png: 'value' });
  });

  it('NFT token metadata on a failing host fails the lookup instead of parsing its error page', async () => {
    quiet();
    const meta = 'https://meta.example/1.json';
    const record = `eip155:1/erc721:${NFT}/1`;
    stubHosts({ [meta]: () => new Response('<html>502 Bad Gateway</html>', { status: 502 }) });
    const hostDown = await outcome(serviceWithRecord(record, meta).getAvatarImage('x.eth'));
    const burned = await outcome(serviceWithRecord(record /* tokenURI reverts */).getAvatarImage('x.eth'));
    expect({ hostDown, burned }).toEqual({ hostDown: 'failure', burned: 'miss' });
  });
});

// ens-avatar 2.0.0-alpha.2's viem adapter maps every record-lookup error to
// null, and both releases read a failed tokenURI() as "no token URI". The
// client view AvatarService hands the library (observeLookups) reports those
// failures, so they still fail the lookup. These go through real viem against
// a fake JSON-RPC endpoint.
describe('RPC and gateway failures that the library swallows', () => {
  type Answer =
    | { record: string }
    | { revert: Hex }
    | { status: number }
    | { tokenURI: string }
    | { rpcError: { code: number; message: string; data?: string } };

  function stubRpc(onText: () => Answer, onTokenURI: () => Answer = () => ({ status: 500 }), media?: (url: string) => Response) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== RPC) return media ? media(url) : new Response('not found', { status: 404 });
      const req = JSON.parse(String(init?.body)) as { id: number; params: [{ to: string; data: Hex }] };
      const { to, data } = req.params[0];
      let answer: Answer;
      if (to.toLowerCase() === NFT && data.startsWith(TOKEN_URI_SELECTOR)) {
        answer = onTokenURI();
      } else {
        const { args } = decodeFunctionData({ abi: urAbi, data });
        // Only the text record matters; the address lookup finds no resolver.
        answer = (args[1] as Hex).startsWith(TEXT_SELECTOR)
          ? onText()
          : { revert: encodeErrorResult({ abi: urAbi, errorName: 'ResolverNotFound', args: ['0x'] }) };
      }
      if ('status' in answer) return new Response('upstream down', { status: answer.status });
      if ('rpcError' in answer) return Response.json({ jsonrpc: '2.0', id: req.id, error: answer.rpcError });
      const reply =
        'revert' in answer
          ? { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data: answer.revert } }
          : {
              jsonrpc: '2.0',
              id: req.id,
              result:
                'record' in answer
                  ? encodeFunctionResult({
                      abi: urAbi,
                      functionName: 'resolveWithGateways',
                      result: [encodeFunctionResult({ abi: textAbi, functionName: 'text', result: answer.record }), RESOLVER],
                    })
                  : encodeFunctionResult({ abi: nftAbi, functionName: 'tokenURI', result: answer.tokenURI }),
            };
      return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
    }));
  }

  const urRevert = (errorName: 'ResolverNotFound' | 'HttpError', args: readonly unknown[]) => ({
    revert: encodeErrorResult({ abi: urAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]),
  });

  it('the text-record lookup: an RPC or gateway outage fails it; "no resolver" and a gateway 4xx are misses', async () => {
    quiet();
    const results: Record<string, string> = {};
    const cases: Array<[string, () => Answer]> = [
      ['rpc 503', () => ({ status: 503 })],
      ['rpc 401', () => ({ status: 401 })],
      ['gateway HttpError 503', () => urRevert('HttpError', [503, 'suspended'])],
      ['gateway HttpError 429', () => urRevert('HttpError', [429, 'slow down'])],
      ['gateway HttpError 408', () => urRevert('HttpError', [408, 'timeout'])],
      ['no resolver', () => urRevert('ResolverNotFound', ['0x'])],
      ['gateway HttpError 404', () => urRevert('HttpError', [404, 'unknown name'])],
      ['gateway HttpError 400', () => urRevert('HttpError', [400, 'unsupported name'])],
      ['gateway HttpError 403', () => urRevert('HttpError', [403, 'blocked name'])],
    ];
    for (const [label, onText] of cases) {
      stubRpc(onText);
      results[label] = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));
    }
    expect(results).toEqual({
      'rpc 503': 'failure',
      'rpc 401': 'failure',
      'gateway HttpError 503': 'failure',
      'gateway HttpError 429': 'failure',
      'gateway HttpError 408': 'failure',
      'no resolver': 'miss',
      'gateway HttpError 404': 'miss',
      'gateway HttpError 400': 'miss',
      'gateway HttpError 403': 'miss',
    });
  });

  it('the text-record lookup through the batch gateway: a gateway URL the guard refuses is a miss', async () => {
    quiet();
    const batchAbi = parseAbi([
      'function query((address sender, string[] urls, bytes data)[]) view returns (bool[] failures, bytes[] responses)',
    ]);
    const lookupAbi = parseAbi([
      'error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)',
    ]);
    const CALLBACK = '0x12345678';
    // A Universal Resolver whose resolver answers the text record with an
    // OffchainLookup through viem's local batch gateway; the callback reverts
    // with the failed query's error, as the Universal Resolver does.
    const run = async (gateways: string[], gatewayStatus: number) => {
      const gatewayFetches: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url !== RPC) {
          gatewayFetches.push(url);
          return new Response('gateway says no', { status: gatewayStatus });
        }
        const req = JSON.parse(String(init?.body)) as { id: number; params: [{ to: Hex; data: Hex }] };
        const { to, data } = req.params[0];
        const revert = (d: Hex) => Response.json({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data: d } });
        if (data.startsWith(CALLBACK)) {
          const [response] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], `0x${data.slice(10)}`);
          const [failures, responses] = decodeFunctionResult({ abi: batchAbi, functionName: 'query', data: response });
          expect(failures).toEqual([true]);
          return revert(responses[0]);
        }
        const { args } = decodeFunctionData({ abi: urAbi, data });
        if (!(args[1] as Hex).startsWith(TEXT_SELECTOR)) {
          return revert(encodeErrorResult({ abi: urAbi, errorName: 'ResolverNotFound', args: ['0x'] }));
        }
        const callData = encodeFunctionData({ abi: batchAbi, functionName: 'query', args: [[{ sender: RESOLVER, urls: gateways, data: '0x1234' }]] });
        return revert(encodeErrorResult({ abi: lookupAbi, errorName: 'OffchainLookup', args: [to, ['x-batch-gateway:true'], callData, CALLBACK, '0x'] }));
      }));
      const result = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));
      return { result, gatewayFetches: gatewayFetches.length };
    };

    // Refused by the guard (private host): never fetched, and a miss.
    expect(await run(['https://127.0.0.1/{sender}/{data}.json'], 503)).toEqual({ result: 'miss', gatewayFetches: 0 });
    // A gateway that fails outranks a refused one.
    expect(await run(['https://127.0.0.1/{sender}/{data}.json', 'https://gw.example/{sender}/{data}.json'], 503))
      .toEqual({ result: 'failure', gatewayFetches: 1 });
    expect(await run(['https://gw.example/{sender}/{data}.json'], 400)).toEqual({ result: 'miss', gatewayFetches: 1 });
    expect(await run(['https://gw.example/{sender}/{data}.json'], 429)).toEqual({ result: 'failure', gatewayFetches: 1 });
  });

  it('an NFT avatar whose tokenURI() read fails at the RPC fails the lookup; a reverting tokenURI() is a miss', async () => {
    quiet();
    const record = `eip155:1/erc721:${NFT}/1`;
    stubRpc(() => ({ record }), () => ({ status: 503 }));
    const rpcDown = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));

    const invalidToken = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['ERC721: invalid token ID'] });
    stubRpc(() => ({ record }), () => ({ revert: invalidToken }));
    const burned = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));

    stubRpc(
      () => ({ record }),
      () => ({ tokenURI: 'https://meta.example/1.json' }),
      (url) =>
        url === 'https://meta.example/1.json'
          ? new Response(JSON.stringify({ image: 'https://cdn.example/1.png' }), { headers: { 'content-type': 'application/json' } })
          : new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    );
    const ok = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));

    expect({ rpcDown, burned, ok }).toEqual({ rpcDown: 'failure', burned: 'miss', ok: 'value' });
  });

  it('a tokenURI() read: every RPC error is a failure, a revert with or without a reason is a miss', async () => {
    quiet();
    const record = `eip155:1/erc721:${NFT}/1`;
    const results: Record<string, string> = {};
    const cases: Array<[string, () => Answer]> = [
      // viem types -32603 as a revert whose data is the RPC error's data.
      ['rpc -32603 internal error', () => ({ rpcError: { code: -32603, message: 'Internal error' } })],
      ['rpc -32603 internal error with data 0x', () => ({ rpcError: { code: -32603, message: 'Internal error', data: '0x' } })],
      ['rpc -32603 internal error with text data', () => ({ rpcError: { code: -32603, message: 'Internal error', data: 'request timed out' } })],
      ['rpc 401', () => ({ status: 401 })],
      ['rpc 403', () => ({ status: 403 })],
      ['revert without data', () => ({ rpcError: { code: 3, message: 'execution reverted' } })],
      ['revert with data 0x', () => ({ rpcError: { code: 3, message: 'execution reverted', data: '0x' } })],
      ['revert without data (-32603)', () => ({ rpcError: { code: -32603, message: 'execution reverted' } })],
      ['revert without data (-32000)', () => ({ rpcError: { code: -32000, message: 'execution reverted' } })],
    ];
    for (const [label, onTokenURI] of cases) {
      stubRpc(() => ({ record }), onTokenURI);
      results[label] = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));
    }
    expect(results).toEqual({
      'rpc -32603 internal error': 'failure',
      'rpc -32603 internal error with data 0x': 'failure',
      'rpc -32603 internal error with text data': 'failure',
      'rpc 401': 'failure',
      'rpc 403': 'failure',
      'revert without data': 'miss',
      'revert with data 0x': 'miss',
      'revert without data (-32603)': 'miss',
      'revert without data (-32000)': 'miss',
    });
  });

  it('an NFT whose tokenURI() is served by a CCIP gateway: a gateway 4xx or a refused gateway is a miss, a gateway 503 or 429 fails the lookup', async () => {
    quiet();
    const record = `eip155:1/erc721:${NFT}/1`;
    const offchainLookup = (gateway: string) => encodeErrorResult({
      abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
      errorName: 'OffchainLookup',
      args: [NFT, [gateway], '0x1234', '0x12345678', '0x'],
    });
    const results: Record<string, string> = {};
    for (const status of [404, 400, 403, 503, 429]) {
      stubRpc(() => ({ record }), () => ({ revert: offchainLookup('https://gw.example/{sender}/{data}.json') }), () => new Response('gateway says no', { status }));
      results[status] = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));
    }
    const media = vi.fn(() => new Response('unreachable', { status: 503 }));
    stubRpc(() => ({ record }), () => ({ revert: offchainLookup('https://127.0.0.1/{sender}/{data}.json') }), media);
    results.refused = await outcome(new AvatarService(RPC, mainnet).getAvatarImage('nick.eth'));
    expect(media).not.toHaveBeenCalled();
    expect(results).toEqual({ 404: 'miss', 400: 'miss', 403: 'miss', 503: 'failure', 429: 'failure', refused: 'miss' });
  });
});
