import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPublicClient, encodeErrorResult, encodeFunctionData, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { createMockEnv } from './mocks/hono-env';
import { guardedCcipRequest, MAX_CCIP_RESPONSE_BYTES } from '../src/services/ccip-request';
import { withRequestBudget, MAX_CCIP_BYTES_PER_REQUEST } from '../src/services/request-budget';

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
