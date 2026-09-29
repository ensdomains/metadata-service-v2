import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionData, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { createMockEnv } from './mocks/hono-env';
import { ccipBudgetedHttp, guardedCcipRequest, MAX_CCIP_RESPONSE_BYTES } from '../src/services/ccip-request';
import { MAX_MEDIA_REDIRECTS } from '../src/services/media-fetch';
import {
  withRequestBudget,
  MAX_CCIP_BYTES_PER_REQUEST,
  MAX_CCIP_REQUESTS_PER_REQUEST,
  MAX_OFFCHAIN_LOOKUPS_PER_REQUEST,
} from '../src/services/request-budget';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

// Round-2 review finding (WEB-1550): the per-response CCIP cap does not bound a
// lookup. A contract can revert with OffchainLookup(urls=['x-batch-gateway:true'])
// and a batch of N queries; viem then requests all N gateways at once and keeps
// every response. Gateway bytes are now charged, chunk by chunk as they arrive,
// to a budget scoped to the incoming request.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const offchainLookup = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']);
const batchAbi = parseAbi(['function query((address sender, string[] urls, bytes data)[] queries) view returns (bool[] failures, bytes[] responses)']);
const N = 16;
const CHUNK = 64 * 1024;
// Just under the per-response cap, as an even-length hex string.
const RESPONSE_BYTES = MAX_CCIP_RESPONSE_BYTES - 2;

function batchRevert(sender: `0x${string}`) {
  const queries = Array.from({ length: N }, (_, i) => ({ sender, urls: [`https://gw.example/${i}/{data}`], data: '0x01' as `0x${string}` }));
  return encodeErrorResult({
    abi: offchainLookup,
    errorName: 'OffchainLookup',
    args: [sender, ['x-batch-gateway:true'], encodeFunctionData({ abi: batchAbi, functionName: 'query', args: [queries] }), '0x12345678', '0x'],
  });
}

// A gateway body of RESPONSE_BYTES hex characters, streamed in CHUNK pieces;
// `counter.pulled` counts only what the reader actually pulled.
function streamedHex(counter: { pulled: number }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= RESPONSE_BYTES) return controller.close();
      const size = Math.min(CHUNK, RESPONSE_BYTES - sent);
      const text = sent === 0 ? '0x' + 'ab'.repeat((size - 2) / 2) : 'ab'.repeat(size / 2);
      sent += size;
      counter.pulled += size;
      controller.enqueue(encoder.encode(text));
    },
  });
}

// RPC: the first call reverts with the batch lookup; the CCIP callback succeeds.
function stubNetwork(rpcPrefix: string, revert: string) {
  const counter = { pulled: 0, gatewayRequests: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(rpcPrefix)) {
      const body = JSON.parse(String(init?.body));
      const one = (b: { id: number; params: [{ data: string }] }) =>
        b.params?.[0]?.data?.startsWith('0x12345678')
          ? { jsonrpc: '2.0', id: b.id, result: '0x' }
          : { jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted', data: revert } };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
    }
    counter.gatewayRequests++;
    return new Response(streamedHex(counter), { headers: { 'content-type': 'text/plain' } });
  }));
  return counter;
}

// Bytes pulled from gateways can exceed the allowance by at most two chunks per
// concurrent reader: the chunk that was refused, plus one the stream had already
// queued ahead of the reader (both are discarded when the read is cancelled).
const bound = (lookups: number) => MAX_CCIP_BYTES_PER_REQUEST + lookups * N * 2 * CHUNK;
// Once the turns are spent, each further call site in a route costs the one
// eth_call whose revert is refused (measured: 2 on /avatar).
const ROUTE_CALL_SITES = 4;

describe('CCIP batch-gateway fan-out', () => {
  const RESOLVER = '0x2222222222222222222222222222222222222222' as const;
  const client = () =>
    createPublicClient({ chain: mainnet, transport: http('https://rpc.example', { retryCount: 0 }), ccipRead: { request: guardedCcipRequest } });

  it('control: without a request scope every gateway is read in full', async () => {
    const counter = stubNetwork('https://rpc.example', batchRevert(RESOLVER));
    await client().call({ to: RESOLVER, data: '0xdeadbeef' }).catch(() => {});
    expect(counter.pulled).toBe(N * RESPONSE_BYTES); // 16 MiB
  }, 120_000);

  it('inside one request, reading stops once the per-request allowance is spent', async () => {
    const counter = stubNetwork('https://rpc.example', batchRevert(RESOLVER));
    await withRequestBudget(() => client().call({ to: RESOLVER, data: '0xdeadbeef' })).catch(() => {});
    expect(counter.gatewayRequests).toBe(N);
    expect(counter.pulled).toBeLessThanOrEqual(bound(1));
    expect(counter.pulled).toBeLessThan(N * RESPONSE_BYTES);
  }, 120_000);

  it('through a real route, the Worker scopes the allowance to the incoming request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = createMockEnv() as unknown as Record<string, string>;
    const counter = stubNetwork(env.MAINNET_RPC_URL, batchRevert(mainnet.contracts.ensUniversalResolver.address));
    const { default: app } = await import('../src/index');
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await app.request('/mainnet/avatar/attacker.eth', undefined, env, ctx);
    expect(counter.gatewayRequests).toBeGreaterThan(0);
    // Avatar resolution may run a few lookups, all inside the same request.
    expect(counter.pulled).toBeLessThanOrEqual(bound(4));
    expect(counter.pulled).toBeLessThan((counter.gatewayRequests) * RESPONSE_BYTES);
  }, 120_000);
});

// viem follows OffchainLookup recursively with no depth limit: the callback
// reverts with a new OffchainLookup, viem calls the gateway and then the
// contract again, and so on. A turn costs one RPC eth_call plus a gateway fetch
// of a few bytes, or no fetch at all when the lookup goes to the local batch
// gateway with no queries (or with a query that lists no URLs), which neither
// the byte allowance nor guardedCcipRequest ever sees. The stub fails every
// fetch past SUBREQUEST_LIMIT, as the Workers runtime does, so an unbounded loop
// terminates.
describe('recursive OffchainLookup', () => {
  const SUBREQUEST_LIMIT = 1000;
  const LOOPING = '0x3333333333333333333333333333333333333333' as const;
  const OTHER = '0x4444444444444444444444444444444444444444' as const;
  const WORD = `0x${'00'.repeat(31)}2a` as const;
  type Shape = 'gateway' | 'empty-batch' | 'empty-urls';
  type EthCall = { to: string; data: string };

  function lookupRevert(sender: `0x${string}`, shape: Shape) {
    if (shape === 'gateway') {
      return encodeErrorResult({ abi: offchainLookup, errorName: 'OffchainLookup', args: [sender, ['https://gw.example/{data}'], '0x01', '0x12345678', '0x'] });
    }
    const queries = shape === 'empty-batch' ? [] : [{ sender, urls: [] as string[], data: '0x01' as `0x${string}` }];
    return encodeErrorResult({
      abi: offchainLookup,
      errorName: 'OffchainLookup',
      args: [sender, ['x-batch-gateway:true'], encodeFunctionData({ abi: batchAbi, functionName: 'query', args: [queries] }), '0x12345678', '0x'],
    });
  }

  const reverting = (data: string) => ({ error: { code: 3, message: 'execution reverted', data } });

  // `reply` answers each eth_call; every gateway returns a few bytes.
  function stubNetworkCalls(rpcPrefix: string, reply: (call: EthCall) => object) {
    const counter = { gatewayRequests: 0, ethCalls: 0 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (counter.gatewayRequests + counter.ethCalls >= SUBREQUEST_LIMIT) throw new Error('Too many subrequests.');
      if (url.startsWith(rpcPrefix)) {
        const body = JSON.parse(String(init?.body));
        const one = (b: { id: number; method: string; params: [EthCall] }) => {
          if (b.method !== 'eth_call') return { jsonrpc: '2.0', id: b.id, result: '0x1' };
          counter.ethCalls++;
          return { jsonrpc: '2.0', id: b.id, ...reply(b.params[0]) };
        };
        return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
      }
      counter.gatewayRequests++;
      return new Response('0x01', { headers: { 'content-type': 'text/plain' } });
    }));
    return counter;
  }

  const client = () =>
    createPublicClient({ chain: mainnet, transport: ccipBudgetedHttp('https://rpc.example', { retryCount: 0 }), ccipRead: { request: guardedCcipRequest } });

  for (const shape of ['gateway', 'empty-batch', 'empty-urls'] as const) {
    it(`${shape}: control, without a request scope one call loops until the subrequest limit`, async () => {
      const counter = stubNetworkCalls('https://rpc.example', () => reverting(lookupRevert(LOOPING, shape)));
      await client().call({ to: LOOPING, data: '0xdeadbeef' }).catch(() => {});
      expect(counter.gatewayRequests + counter.ethCalls).toBe(SUBREQUEST_LIMIT);
    }, 120_000);

    it(`${shape}: inside one request the lookup ends after the turn budget`, async () => {
      const counter = stubNetworkCalls('https://rpc.example', () => reverting(lookupRevert(LOOPING, shape)));
      await expect(withRequestBudget(() => client().call({ to: LOOPING, data: '0xdeadbeef' }))).rejects.toThrow();
      // Every turn is an eth_call; the one over the budget is not followed.
      expect(counter.ethCalls).toBe(MAX_OFFCHAIN_LOOKUPS_PER_REQUEST + 1);
      expect(counter.gatewayRequests).toBe(shape === 'gateway' ? MAX_OFFCHAIN_LOOKUPS_PER_REQUEST : 0);
    }, 120_000);
  }

  it('a real lookup (one turn, then the callback answers) is unaffected', async () => {
    stubNetworkCalls('https://rpc.example', ({ data }) => (data.startsWith('0x12345678') ? { result: WORD } : reverting(lookupRevert(LOOPING, 'gateway'))));
    const { data } = await withRequestBudget(() => client().call({ to: LOOPING, data: '0xdeadbeef' }));
    expect(data).toBe(WORD);
  });

  it('calls that do not revert with OffchainLookup still work after the turns are spent', async () => {
    stubNetworkCalls('https://rpc.example', ({ to }) => (to.toLowerCase() === LOOPING ? reverting(lookupRevert(LOOPING, 'empty-batch')) : { result: WORD }));
    await withRequestBudget(async () => {
      await expect(client().call({ to: LOOPING, data: '0xdeadbeef' })).rejects.toThrow();
      const { data } = await client().call({ to: OTHER, data: '0xdeadbeef' });
      expect(data).toBe(WORD);
    });
  });

  it('one batch lookup sends at most MAX_CCIP_REQUESTS_PER_REQUEST gateway requests', async () => {
    const queries = Array.from({ length: 100 }, (_, i) => ({ sender: LOOPING, urls: [`https://gw.example/${i}/{data}`], data: '0x01' as `0x${string}` }));
    const revert = encodeErrorResult({
      abi: offchainLookup,
      errorName: 'OffchainLookup',
      args: [LOOPING, ['x-batch-gateway:true'], encodeFunctionData({ abi: batchAbi, functionName: 'query', args: [queries] }), '0x12345678', '0x'],
    });
    const counter = stubNetworkCalls('https://rpc.example', ({ data }) => (data.startsWith('0x12345678') ? { result: WORD } : reverting(revert)));
    await withRequestBudget(() => client().call({ to: LOOPING, data: '0xdeadbeef' })).catch(() => {});
    expect(counter.gatewayRequests).toBe(MAX_CCIP_REQUESTS_PER_REQUEST);
  });

  async function requestAvatar(env: Record<string, string>) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: app } = await import('../src/index');
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    return app.request('/mainnet/avatar/attacker.eth', undefined, env, ctx);
  }

  it('through /avatar, a looping resolver lookup stays within both caps', async () => {
    const env = createMockEnv() as unknown as Record<string, string>;
    const counter = stubNetworkCalls(env.MAINNET_RPC_URL, () => reverting(lookupRevert(mainnet.contracts.ensUniversalResolver.address, 'gateway')));
    await requestAvatar(env);
    expect(counter.gatewayRequests).toBeGreaterThan(0);
    expect(counter.gatewayRequests).toBeLessThanOrEqual(MAX_CCIP_REQUESTS_PER_REQUEST);
    expect(counter.ethCalls).toBeLessThanOrEqual(MAX_OFFCHAIN_LOOKUPS_PER_REQUEST + ROUTE_CALL_SITES);
  }, 120_000);

  it('through /avatar, an NFT avatar whose contract loops on empty batches stays within the turn budget', async () => {
    const env = createMockEnv() as unknown as Record<string, string>;
    const UR = mainnet.contracts.ensUniversalResolver.address.toLowerCase();
    const NFT = '0x5555555555555555555555555555555555555555' as const;
    const urAbi = parseAbi(['function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)']);
    let nftCalls = 0;
    const counter = stubNetworkCalls(env.MAINNET_RPC_URL, ({ to, data }) => {
      if (to.toLowerCase() === NFT) {
        nftCalls++;
        return reverting(lookupRevert(NFT, 'empty-batch'));
      }
      if (to.toLowerCase() !== UR) return { result: '0x' };
      // The avatar text record (text(bytes32,string) = 0x59d1d43c) names the
      // NFT; any other record read (the owner's address) returns OTHER.
      const record = (decodeFunctionData({ abi: urAbi, data: data as `0x${string}` }).args[1] as string).startsWith('0x59d1d43c')
        ? encodeAbiParameters([{ type: 'string' }], [`eip155:1/erc721:${NFT}/1`])
        : encodeAbiParameters([{ type: 'address' }], [OTHER]);
      return { result: encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [record, OTHER]) };
    });
    await requestAvatar(env);
    expect(nftCalls).toBeGreaterThan(0);
    expect(nftCalls).toBeLessThanOrEqual(MAX_OFFCHAIN_LOOKUPS_PER_REQUEST + ROUTE_CALL_SITES);
    expect(counter.gatewayRequests).toBe(0);
  }, 120_000);
});

// A gateway may answer with a redirect, and fetchMediaUrl follows up to
// MAX_MEDIA_REDIRECTS of them. Every hop is a Worker subrequest, so every hop is
// charged to the allowance, not just the first request to each gateway URL.
describe('gateway redirect hops', () => {
  const REDIRECTING = '0x6666666666666666666666666666666666666666' as const;
  const GATEWAYS = 5;

  function stubRedirectingGateways() {
    const revert = encodeErrorResult({
      abi: offchainLookup,
      errorName: 'OffchainLookup',
      args: [REDIRECTING, Array.from({ length: GATEWAYS }, (_, i) => `https://gw${i}.example/{data}`), '0x01', '0x12345678', '0x'],
    });
    const counter = { gatewayFetches: 0 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://rpc.example')) {
        const body = JSON.parse(String(init?.body));
        const one = (b: { id: number }) => ({ jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted', data: revert } });
        return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
      }
      counter.gatewayFetches++;
      return new Response(null, { status: 302, headers: { Location: `${new URL(url).origin}/hop/${counter.gatewayFetches}` } });
    }));
    return counter;
  }

  const client = () =>
    createPublicClient({ chain: mainnet, transport: ccipBudgetedHttp('https://rpc.example', { retryCount: 0 }), ccipRead: { request: guardedCcipRequest } });

  it('control: without a request scope every gateway follows all of its redirects', async () => {
    const counter = stubRedirectingGateways();
    await client().call({ to: REDIRECTING, data: '0xdeadbeef' }).catch(() => {});
    expect(counter.gatewayFetches).toBe(GATEWAYS * (MAX_MEDIA_REDIRECTS + 1));
  });

  it('inside one request, every hop is charged and fetching stops at the cap', async () => {
    const counter = stubRedirectingGateways();
    await withRequestBudget(() => client().call({ to: REDIRECTING, data: '0xdeadbeef' })).catch(() => {});
    expect(counter.gatewayFetches).toBe(MAX_CCIP_REQUESTS_PER_REQUEST);
  });
});

describe('after the allowance is spent', () => {
  it('sends no further gateway requests in the same request', async () => {
    const { takeCcipBytes } = await import('../src/services/request-budget');
    const fetchMock = vi.fn(async () => new Response('0x01'));
    vi.stubGlobal('fetch', fetchMock);
    await withRequestBudget(async () => {
      expect(takeCcipBytes(MAX_CCIP_BYTES_PER_REQUEST)).toBe(true);
      expect(takeCcipBytes(1)).toBe(false); // refused: the allowance is spent
      await expect(
        guardedCcipRequest({ data: '0x01', sender: '0x1111111111111111111111111111111111111111', urls: ['https://gw.example/{data}', 'https://gw2.example/{data}'] }),
      ).rejects.toThrow();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
