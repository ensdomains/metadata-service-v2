import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockchainService } from '../src/services/blockchain';
import { IndexerService } from '../src/services/indexer';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { UpstreamError } from '../src/services/errors';
import { withRequestBudget } from '../src/services/request-budget';

// WEB-1552: the retry budget multiplied past the request timeout. The primary
// RPC transport alone (8s timeout, retryCount 2) could spend ~25s of the 30s
// global timeout on a hung endpoint before a fallback was tried, and nothing
// stopped the RPC or indexer chains when the request's time ran out. Each
// request now has one deadline (request-budget.ts) that every RPC and indexer
// attempt checks and is bounded by.

// REQUEST_DEADLINE_MS, spelled out so these tests exercise the behaviour.
const DEADLINE_MS = 25_000;

const PRIMARY = 'https://primary.rpc.example';
const FALLBACK_1 = 'https://fallback-1.rpc.example';
const FALLBACK_2 = 'https://fallback-2.rpc.example';
const env = {
  MAINNET_RPC_URL: PRIMARY,
  MAINNET_FALLBACK_RPC_1: FALLBACK_1,
  MAINNET_FALLBACK_RPC_2: FALLBACK_2,
  SEPOLIA_RPC_URL: 'https://lone.rpc.example', // sepolia has no default fallbacks
};
const NODE = `0x${'ab'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';

const INDEXER = 'https://indexer.example/graphql';
const INDEXER_FALLBACK = 'https://indexer-fallback.example/graphql';

type Handler = (init: RequestInit | undefined) => Promise<Response>;

// Stub fetch per URL; records every call and the signal it carried.
function stubFetch(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, signal: init?.signal });
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(init);
  }));
  return {
    calls,
    count: (url: string) => calls.filter((c) => c.url === url).length,
  };
}

// Never answers; rejects when the request's signal aborts, like fetch.
const hang: Handler = (init) => new Promise<Response>((_, reject) => {
  const signal = init?.signal;
  if (!signal) return;
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

// Answers after `ms` unless the signal aborts first.
const after = (ms: number, respond: Handler): Handler => (init) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(respond(init)), ms);
  init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
});

const status = (code: number): Handler => async () => new Response('unavailable', { status: code });

// eth_call answering an address (registry.owner()).
const rpcOwner: Handler = async (init) => {
  const { id } = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: '2.0', id, result: `0x${'00'.repeat(12)}${OWNER.slice(2)}` });
};

const graphqlDomain: Handler = async () => Response.json({ data: { domain: { id: 'fox.eth', name: 'fox.eth' } } });

// Advance fake time in small steps until `promise` settles (or `maxMs` pass).
async function settle<T>(promise: Promise<T>, maxMs: number) {
  const outcome: { done: boolean; value?: T; error?: unknown; elapsed: number } = { done: false, elapsed: 0 };
  promise.then(
    (value) => { outcome.done = true; outcome.value = value; },
    (error) => { outcome.done = true; outcome.error = error; },
  );
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(0);
  while (!outcome.done && Date.now() - start < maxMs) {
    await vi.advanceTimersByTimeAsync(50);
  }
  outcome.elapsed = Date.now() - start;
  return outcome;
}

// Run `fn` inside a request whose deadline is `leftMs` away.
function inRequest<T>(leftMs: number, fn: () => Promise<T>): Promise<T> {
  return withRequestBudget(() => {
    vi.setSystemTime(Date.now() + DEADLINE_MS - leftMs);
    return fn();
  });
}

function expectDeadlineError(error: unknown) {
  expect(error).toBeInstanceOf(UpstreamError);
  expect((error as Error).name).toBe('RequestDeadlineError');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // AbortSignal.timeout runs on Node's internal timers, out of the fake clock's reach.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RPC fallback chain under the request deadline', () => {
  it('fails a hung primary over to the first fallback after one 5s attempt', async () => {
    const net = stubFetch({ [PRIMARY]: hang, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, () => svc.getOwner('mainnet', NODE)), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBe(OWNER);
    expect(out.elapsed).toBeLessThanOrEqual(5_050);
    expect(net.count(PRIMARY)).toBe(1); // no retry on the endpoint that just hung
    expect(net.count(FALLBACK_1)).toBe(1);
    expect(net.count(FALLBACK_2)).toBe(0);
  });

  it('gives each client one attempt and only the last one a retry', async () => {
    const net = stubFetch({ [PRIMARY]: status(503), [FALLBACK_1]: status(503), [FALLBACK_2]: status(503) });
    const svc = new BlockchainService(env);

    // Outside a request: the transports behave the same, with no deadline.
    const out = await settle(svc.getOwner('mainnet', NODE), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(out.error).toHaveProperty('message', expect.stringContaining('All RPC clients failed for mainnet'));
    expect(net.count(PRIMARY)).toBe(1);
    expect(net.count(FALLBACK_1)).toBe(1);
    expect(net.count(FALLBACK_2)).toBe(2);
  });

  it('keeps one retry on a primary that has no fallback', async () => {
    const lone = env.SEPOLIA_RPC_URL;
    const net = stubFetch({ [lone]: status(503) });
    const svc = new BlockchainService(env);

    const out = await settle(svc.getOwner('sepolia', NODE), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(net.count(lone)).toBe(2);
  });

  it('stops at the deadline: no further client is tried and the error is an UpstreamError', async () => {
    const net = stubFetch({ [PRIMARY]: hang, [FALLBACK_1]: hang, [FALLBACK_2]: hang });
    const svc = new BlockchainService(env);

    // 3s left: less than the primary's 5s timeout.
    const out = await settle(inRequest(3_000, () => svc.getOwner('mainnet', NODE)), 120_000);

    expectDeadlineError(out.error);
    expect(out.elapsed).toBeLessThanOrEqual(3_050);
    expect(net.count(PRIMARY)).toBe(1);
    expect(net.count(FALLBACK_1)).toBe(0);
    expect(net.count(FALLBACK_2)).toBe(0);
    // The deadline reached the RPC fetch itself, not only the await.
    expect(net.calls[0].signal?.aborted).toBe(true);
  });

  it('tries no client at all with less than a second left', async () => {
    const net = stubFetch({ [PRIMARY]: rpcOwner, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(500, () => svc.getOwner('mainnet', NODE)), 60_000);

    expectDeadlineError(out.error);
    expect(out.elapsed).toBeLessThanOrEqual(50);
    expect(net.calls).toHaveLength(0);
  });

  it('cuts an attempt stuck outside the transport at the deadline, only inside a request', async () => {
    const svc = new BlockchainService(env);
    const stuck = vi.fn(() => new Promise<never>(() => {})); // e.g. a stalled CCIP-read gateway

    const inside = await settle(inRequest(2_000, () => svc.executeWithFallback('mainnet', stuck)), 60_000);
    expectDeadlineError(inside.error);
    expect(inside.elapsed).toBeLessThanOrEqual(2_050);
    expect(stuck).toHaveBeenCalledTimes(1); // no fallback started past the deadline

    stuck.mockClear();
    const outside = await settle(svc.executeWithFallback('mainnet', stuck), 60_000);
    expect(outside.done).toBe(false);
    expect(stuck).toHaveBeenCalledTimes(1);
  });

  it('answers from a healthy primary on its first fetch, which carries the request deadline', async () => {
    const net = stubFetch({ [PRIMARY]: rpcOwner, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, () => svc.executeWithFallback('mainnet', (client) =>
      client.readContract({
        address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
        abi: [{ inputs: [{ name: 'node', type: 'bytes32' }], name: 'owner', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' }],
        functionName: 'owner',
        args: [NODE as `0x${string}`],
      }))), 1_000);

    expect(out.value).toEqual({ result: OWNER, usedFallback: false });
    expect(out.elapsed).toBeLessThanOrEqual(50);
    expect(net.calls.map((c) => c.url)).toEqual([PRIMARY]);
    const signal = net.calls[0].signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(signal.aborted).toBe(true);
  });
});

describe('indexer requests under the request deadline', () => {
  it('cuts a hung primary attempt to the time left and starts no retry or fallback after it', async () => {
    const net = stubFetch({ [INDEXER]: hang, [INDEXER_FALLBACK]: hang });
    const indexer = new IndexerService({ primaryEndpoint: INDEXER, fallbackEndpoint: INDEXER_FALLBACK, apiVersion: 'v2' });

    // 1.5s left, under the 2s per-attempt timeout.
    const out = await settle(inRequest(1_500, () => indexer.getDomain('fox.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(out.elapsed).toBeLessThanOrEqual(1_550);
    expect(net.count(INDEXER)).toBe(1);
    expect(net.count(INDEXER_FALLBACK)).toBe(0);
  });

  it('falls back from a hung primary while time is left, bounding the fallback by the deadline', async () => {
    const net = stubFetch({ [INDEXER]: hang, [INDEXER_FALLBACK]: after(1_800, graphqlDomain) });
    const indexer = new IndexerService({ primaryEndpoint: INDEXER, fallbackEndpoint: INDEXER_FALLBACK, apiVersion: 'v2' });

    // Plenty of time: two 2s primary attempts, then the fallback answers.
    const ok = await settle(inRequest(DEADLINE_MS, () => indexer.getDomain('fox.eth')), 60_000);
    expect(ok.error).toBeUndefined();
    expect(ok.value).toMatchObject({ domain: { name: 'fox.eth' }, usedFallback: true });
    expect(ok.elapsed).toBeGreaterThanOrEqual(5_800);
    expect(ok.elapsed).toBeLessThanOrEqual(5_850);
    expect(net.count(INDEXER)).toBe(2);

    // 5.5s left: the fallback gets 1.5s, less than it needs to answer.
    const cut = await settle(inRequest(5_500, () => indexer.getDomain('fox.eth')), 60_000);
    expectDeadlineError(cut.error);
    expect(cut.elapsed).toBeLessThanOrEqual(5_550);
    expect(net.count(INDEXER_FALLBACK)).toBe(2);
  });

  it('does not trip the indexer circuit-breaker when the deadline, not the indexer, ends the query', async () => {
    const net = stubFetch({ [INDEXER]: hang });
    const indexer = new IndexerService({ primaryEndpoint: INDEXER, apiVersion: 'v2' });
    const resolver = { resolveName: vi.fn(async () => { throw new UpstreamError('RPC down'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, {} as any, resolver);

    // 1.5s left: the hung attempt is cut by the deadline, not by the indexer's timeout.
    const out = await settle(inRequest(1_500, () => svc.getDomainMetadata('fox.eth')), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(out.elapsed).toBeLessThanOrEqual(1_550);
    expect(net.count(INDEXER)).toBe(1);
    expect(svc.getStatus().indexerV2.healthy).toBe(true);

    // A failure of the indexer's own still trips it.
    stubFetch({ [INDEXER]: status(500) });
    const failed = await settle(inRequest(DEADLINE_MS, () => svc.getDomainMetadata('fox.eth')), 60_000);
    expect(failed.error).toBeInstanceOf(UpstreamError);
    expect(svc.getStatus().indexerV2.healthy).toBe(false);
  });
});
