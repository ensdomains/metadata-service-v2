import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HttpRequestError,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  type Abi,
  type PublicClient,
} from 'viem';
import {
  BlockchainService,
  CONTRACTS,
  ENS_REGISTRY_ABI,
  ENS_V2_CONTRACTS,
  NAME_WRAPPER_ABI,
  REGISTRY_V2_ABI,
  RESOLVER_ABI,
  UNIVERSAL_RESOLVER_V2_ABI,
} from '../src/services/blockchain';
import { ResolverService } from '../src/services/resolver';
import { IndexerService } from '../src/services/indexer';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { RequestDeadlineError, UpstreamError } from '../src/services/errors';
import { MAX_CCIP_REQUESTS_PER_REQUEST, MAX_UNQUEUED_RPC_ATTEMPTS, takeCcipRequest, withRequestBudget } from '../src/services/request-budget';
import { CcipGatewayError, guardedCcipRequest } from '../src/services/ccip-request';

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

// Connection refused: fetch rejects, as it does for an endpoint that is down.
const unreachable: Handler = async () => { throw new TypeError('fetch failed'); };

// eth_call reverting, as a node answers a contract revert.
const rpcRevert: Handler = async (init) => {
  const { id } = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } });
};

// JSON-RPC rate limit (-32005) in an HTTP 200.
const rpcLimit: Handler = async (init) => {
  const { id } = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: '2.0', id, error: { code: -32005, message: 'limit exceeded' } });
};

// eth_call answering an address (registry.owner()).
const rpcOwner: Handler = async (init) => {
  const { id } = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: '2.0', id, result: `0x${'00'.repeat(12)}${OWNER.slice(2)}` });
};

const ZERO = '0x0000000000000000000000000000000000000000';
const RESOLVER = '0x2222222222222222222222222222222222222222';
const SUBREGISTRY = '0x3333333333333333333333333333333333333333';
const { rootRegistry: ROOT, ethRegistry: ETH, universalResolver: UR } = ENS_V2_CONTRACTS.sepolia;
const ENS_ABI: Abi = [
  ...ENS_REGISTRY_ABI,
  ...NAME_WRAPPER_ABI,
  ...REGISTRY_V2_ABI,
  ...UNIVERSAL_RESOLVER_V2_ABI,
  ...RESOLVER_ABI,
  ...parseAbi(['function nameExpires(uint256 id) view returns (uint256)']),
];

// Key of one contract function in ensNode's overrides.
const at = (address: string, fn: string) => `${address.toLowerCase()}.${fn}`;

// eth_call answering `fn` with `result`.
const answer = (fn: string, result: unknown): Handler => async (init) => {
  const { id } = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: '2.0', id, result: encodeFunctionResult({ abi: ENS_ABI, functionName: fn, result }) });
};

// A node serving the contracts the reads call: the v1 registry (owner OWNER,
// resolver RESOLVER), registrar and NameWrapper, the UR, the v2 root and .eth
// registries (every name REGISTERED, its subregistry SUBREGISTRY) and
// RESOLVER. `overrides` replaces the answer of one contract function.
const ensNode = (overrides: Record<string, Handler> = {}): Handler => (init) => {
  const { params: [{ to, data }] } = JSON.parse(String(init?.body));
  const { functionName } = decodeFunctionData({ abi: ENS_ABI, data });
  const override = overrides[at(to, functionName)];
  if (override) return override(init);
  const subregistries: Record<string, string> = { [ROOT.toLowerCase()]: ETH, [ETH.toLowerCase()]: SUBREGISTRY };
  const results: Record<string, unknown> = {
    owner: OWNER,
    resolver: RESOLVER,
    nameExpires: 0n,
    getData: [OWNER, 0, 0n],
    ROOT_REGISTRY: ROOT,
    getSubregistry: subregistries[to.toLowerCase()] ?? ZERO,
    getResolver: ZERO,
    getStatus: 2,
    getState: { status: 2, expiry: 0n, latestOwner: OWNER, tokenId: 0n, resource: 0n },
    findResolver: [RESOLVER, NODE, 0n],
    findOwner: OWNER,
    text: '',
    addr: OWNER,
    contenthash: '0x',
  };
  return answer(functionName, results[functionName])(init);
};

const GATEWAY = 'https://gateway.example/ccip';

// eth_call reverting with OffchainLookup (EIP-3668), as RESOLVER does when its
// records live behind the CCIP-read gateway GATEWAY.
const offchainLookup: Handler = async (init) => {
  const { id } = JSON.parse(String(init?.body));
  const data = encodeErrorResult({
    abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
    errorName: 'OffchainLookup',
    args: [RESOLVER, [GATEWAY], '0x', '0x00000000', '0x'],
  });
  return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data } });
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

describe('RPC endpoints that failed earlier in the request', () => {
  it('skips a primary that hung earlier in the same request', async () => {
    const net = stubFetch({ [PRIMARY]: hang, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      const first = await svc.getOwner('mainnet', NODE);
      const start = Date.now();
      const second = await svc.getOwner('mainnet', NODE);
      return { first, second, secondMs: Date.now() - start };
    }), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ first: OWNER, second: OWNER });
    expect(out.value!.secondMs).toBeLessThanOrEqual(50); // not another 5s on the hung primary
    expect(net.count(PRIMARY)).toBe(1);
    expect(net.count(FALLBACK_1)).toBe(2);
  });

  it('treats a URL configured twice as one endpoint', async () => {
    const net = stubFetch({ [PRIMARY]: hang, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService({ ...env, MAINNET_FALLBACK_RPC_1: PRIMARY });

    const out = await settle(inRequest(DEADLINE_MS, () => svc.getOwner('mainnet', NODE)), 60_000);

    expect(out.value).toBe(OWNER);
    expect(out.elapsed).toBeLessThanOrEqual(5_050); // not a second 5s on the same URL
    expect(net.count(PRIMARY)).toBe(1);
    expect(net.count(FALLBACK_2)).toBe(1);
  });

  it.each([
    ['HTTP 429', status(429)],
    ['HTTP 503', status(503)],
    ['a JSON-RPC rate limit', rpcLimit],
  ])('keeps an endpoint that answered %s', async (_, busy) => {
    const net = stubFetch({ [PRIMARY]: busy, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      await svc.getOwner('mainnet', NODE);
      await svc.getOwner('mainnet', NODE);
    }), 60_000);

    expect(out.error).toBeUndefined();
    expect(net.count(PRIMARY)).toBe(2); // asked again on the next read
    expect(net.count(FALLBACK_1)).toBe(2);
  });

  it('does not mark an endpoint when a name\'s resolver runs past the RPC timeout', async () => {
    // Every endpoint is healthy: only this resolver's text() burns gas past the
    // 5s timeout, on every node.
    const node = ensNode({ [at(RESOLVER, 'text')]: hang });
    const net = stubFetch({ [PRIMARY]: node, [FALLBACK_1]: node, [FALLBACK_2]: node });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      const text = await svc.getText('mainnet', RESOLVER, NODE, 'avatar').catch((e: unknown) => e);
      const fetches = net.calls.length;
      // Another name's read later in the same request, e.g. in a batch.
      const owner = await svc.getOwner('mainnet', NODE);
      return { text, owner, urls: net.calls.slice(fetches).map((c) => c.url) };
    }), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value!.text).toBeInstanceOf(UpstreamError);
    expect(out.value!.owner).toBe(OWNER);
    expect(out.value!.urls).toEqual([PRIMARY]);
  });

  // A wrapped name with no resolver.
  const wrappedName = {
    [at(CONTRACTS.mainnet.registry, 'owner')]: answer('owner', CONTRACTS.mainnet.nameWrapper),
    [at(CONTRACTS.mainnet.registry, 'resolver')]: answer('resolver', ZERO),
  };

  it.each([
    ['was marked earlier in the request', hang, 5_050],
    ['fails the NameWrapper read', ensNode({ ...wrappedName, [at(CONTRACTS.mainnet.nameWrapper, 'getData')]: status(503) }), 50],
  ])('reads NameWrapper data from a fallback when the primary %s', async (_, primary, maxMs) => {
    const wrapped = ensNode(wrappedName);
    stubFetch({ [PRIMARY]: primary, [FALLBACK_1]: wrapped, [FALLBACK_2]: wrapped });
    const resolver = new ResolverService(new BlockchainService(env));

    const out = await settle(inRequest(DEADLINE_MS, () => resolver.resolveName('wrapped.eth', '1', 'mainnet')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value!.resolver).toMatchObject({ isWrapped: true, registrant: OWNER, fuses: 0 });
    expect(out.elapsed).toBeLessThanOrEqual(maxMs);
  });

  it('forgets failed endpoints when the request ends, and remembers none outside a request', async () => {
    const net = stubFetch({ [PRIMARY]: unreachable, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    await settle(inRequest(DEADLINE_MS, () => svc.getOwner('mainnet', NODE)), 60_000);
    await settle(inRequest(DEADLINE_MS, () => svc.getOwner('mainnet', NODE)), 60_000);
    expect(net.count(PRIMARY)).toBe(2);

    await settle(svc.getOwner('mainnet', NODE), 60_000);
    await settle(svc.getOwner('mainnet', NODE), 60_000);
    expect(net.count(PRIMARY)).toBe(4);
    expect(net.count(FALLBACK_1)).toBe(4);
  });

  it('keeps an endpoint that answered with a revert', async () => {
    const net = stubFetch({ [PRIMARY]: rpcRevert, [FALLBACK_1]: rpcRevert, [FALLBACK_2]: rpcRevert });
    const svc = new BlockchainService(env);
    const owner = (client: PublicClient) => client.readContract({
      address: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
      abi: [{ inputs: [{ name: 'node', type: 'bytes32' }], name: 'owner', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' }],
      functionName: 'owner',
      args: [NODE as `0x${string}`],
    });

    await settle(inRequest(DEADLINE_MS, async () => {
      await svc.executeWithFallback('mainnet', owner, { markEndpointFailures: true }).catch(() => {});
      await svc.executeWithFallback('mainnet', owner, { markEndpointFailures: true }).catch(() => {});
    }), 60_000);

    expect(net.count(PRIMARY)).toBe(2);
    expect(net.count(FALLBACK_1)).toBe(2);
  });

  it('keeps an endpoint when a CCIP-read gateway, not the endpoint, failed', async () => {
    const svc = new BlockchainService(env);
    // viem's OffchainLookupError, wrapping the HttpRequestError of a gateway it
    // could not reach.
    const gatewayDown = Object.assign(new Error('Offchain lookup failed', {
      cause: new HttpRequestError({ url: 'https://gateway.example' }),
    }), { name: 'OffchainLookupError' });
    const endpointDown = new HttpRequestError({ url: PRIMARY });
    const clients: PublicClient[] = [];
    const run = (fail: Error) => {
      let first = true;
      return svc.executeWithFallback('mainnet', async (client) => {
        clients.push(client);
        if (first) { first = false; throw fail; }
        return 'ok';
      }, { markEndpointFailures: true });
    };

    await settle(inRequest(DEADLINE_MS, async () => {
      await run(gatewayDown); // primary throws, fallback 1 answers
      await run(endpointDown); // primary tried again, throws, fallback 1 answers
      await run(endpointDown); // primary skipped: fallback 1 throws, fallback 2 answers
    }), 60_000);

    const [primary, fallback1, fallback2] = svc.getAllClients('mainnet');
    expect(clients).toEqual([primary, fallback1, primary, fallback1, fallback1, fallback2]);
  });

  it('fails at once when every endpoint already failed in this request, with the error that marked it', async () => {
    const net = stubFetch({ [PRIMARY]: unreachable, [FALLBACK_1]: unreachable, [FALLBACK_2]: unreachable });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      const first = await svc.getOwner('mainnet', NODE).catch((e: unknown) => e);
      const fetches = net.calls.length;
      const start = Date.now();
      const error = await svc.getOwner('mainnet', NODE).catch((e: unknown) => e);
      return { first, error, fetches: net.calls.length - fetches, ms: Date.now() - start };
    }), 60_000);

    expect(out.value!.error).toBeInstanceOf(UpstreamError);
    expect(out.value!.fetches).toBe(0);
    expect(out.value!.ms).toBe(0);
    // The last endpoint's own error, as the first read's UpstreamError carries it.
    expect((out.value!.error as Error).cause).toBeInstanceOf(Error);
    expect((out.value!.error as Error).cause).toBe((out.value!.first as Error).cause);
  });

  it('does not mark an endpoint from reads that may have waited for a connection', async () => {
    const net = stubFetch({ [PRIMARY]: hang, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      // One read more than can be in flight without queueing: none of their
      // timeouts is surely the endpoint's own (the reads of a name's resolver
      // can be made to hang and fill the invocation's connections).
      await Promise.all(Array.from({ length: MAX_UNQUEUED_RPC_ATTEMPTS + 1 }, () => svc.getOwner('mainnet', NODE)));
      const concurrent = net.count(PRIMARY);
      await svc.getOwner('mainnet', NODE); // alone: its timeout is the endpoint's, so it marks
      await svc.getOwner('mainnet', NODE); // skips the primary
      return { concurrent, total: net.count(PRIMARY) };
    }), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({ concurrent: MAX_UNQUEUED_RPC_ATTEMPTS + 1, total: MAX_UNQUEUED_RPC_ATTEMPTS + 2 });
  });

  it('marks an endpoint from concurrent reads that cannot have waited for a connection', async () => {
    const net = stubFetch({ [PRIMARY]: hang, [FALLBACK_1]: rpcOwner, [FALLBACK_2]: rpcOwner });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      await Promise.all(Array.from({ length: MAX_UNQUEUED_RPC_ATTEMPTS }, () => svc.getOwner('mainnet', NODE)));
      const start = Date.now();
      await svc.getOwner('mainnet', NODE);
      return { primary: net.count(PRIMARY), nextMs: Date.now() - start };
    }), 60_000);

    expect(out.value).toEqual({ primary: MAX_UNQUEUED_RPC_ATTEMPTS, nextMs: expect.any(Number) });
    expect(out.value!.nextMs).toBeLessThanOrEqual(50);
  });

  it('keeps the first error that marked an endpoint', async () => {
    stubFetch({ [env.SEPOLIA_RPC_URL]: unreachable });
    const svc = new BlockchainService(env);

    const failure = (read: Promise<unknown>) => read.then(() => undefined, (e: Error) => e);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      // Both reads are in flight on the endpoint when it fails.
      const [a, b] = await Promise.all([failure(svc.getOwner('sepolia', NODE)), failure(svc.getOwner('sepolia', NODE))]);
      const c = await failure(svc.getOwner('sepolia', NODE));
      return { a, b, c };
    }), 60_000);

    const { a, b, c } = out.value!;
    expect(a?.cause).toBeInstanceOf(Error);
    expect(b?.cause).not.toBe(a?.cause);
    expect(c?.cause).toBe(a?.cause);
  });

  it.each([
    ['answers 502', status(502)],
    ['cannot be reached in time', hang],
  ])('keeps an endpoint whose CCIP-read gateway %s, through viem\'s OffchainLookup handling', async (_, gateway) => {
    const lone = env.SEPOLIA_RPC_URL;
    const net = stubFetch({ [lone]: ensNode({ [at(RESOLVER, 'text')]: offchainLookup }), [GATEWAY]: gateway });
    const svc = new BlockchainService(env);
    const text = (client: PublicClient) => client.readContract({
      address: RESOLVER,
      abi: RESOLVER_ABI,
      functionName: 'text',
      args: [NODE as `0x${string}`, 'avatar'],
    });

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      // A marking read, so only the OffchainLookup exclusion keeps the endpoint.
      const lookup = await svc.executeWithFallback('sepolia', text, { markEndpointFailures: true })
        .catch((e: Error) => e);
      const owner = await svc.getOwner('sepolia', NODE);
      return { lookup, owner };
    }), 60_000);

    expect(net.count(GATEWAY)).toBe(1);
    expect(out.value!.lookup).toBeInstanceOf(UpstreamError);
    expect(out.value!.owner).toBe(OWNER);
  });
});

describe('which RPC reads mark an endpoint', () => {
  // sepolia has one endpoint: once it is marked, every later read fails at once.
  const lone = env.SEPOLIA_RPC_URL;

  // Reads that run only in ENS's own contracts.
  it.each([
    ['the v1 registry owner', at(CONTRACTS.sepolia.registry, 'owner'), (svc: BlockchainService) => svc.getOwner('sepolia', NODE)],
    ['the v1 registry resolver', at(CONTRACTS.sepolia.registry, 'resolver'), (svc: BlockchainService) => svc.getResolver('sepolia', NODE)],
    ['the .eth registrar expiry', at(CONTRACTS.sepolia.registrar, 'nameExpires'), (svc: BlockchainService) => svc.getExpiry('sepolia', NODE)],
    ['the UR root registry', at(UR, 'ROOT_REGISTRY'), (svc: BlockchainService) => svc.getV2Registries('sepolia')],
    ['the root registry\'s .eth entry', at(ROOT, 'getSubregistry'), (svc: BlockchainService) => svc.getV2Registries('sepolia')],
    ['the .eth registry status', at(ETH, 'getStatus'), (svc: BlockchainService) => svc.isUnmigratedName('sepolia', 'name.eth')],
    ['the .eth registry state', at(ETH, 'getState'), (svc: BlockchainService) => svc.getV2Registration('sepolia', 'name.eth')],
  ])('marks it when %s times out', async (_, slow, read) => {
    const net = stubFetch({ [lone]: ensNode({ [slow]: hang }) });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      await read(svc).catch(() => {});
      const fetches = net.calls.length;
      const error = await svc.getOwner('sepolia', NODE).catch((e: unknown) => e);
      return { error, fetches: net.calls.length - fetches };
    }), 60_000);

    expect(out.value!.error).toBeInstanceOf(UpstreamError);
    expect(out.value!.fetches).toBe(0);
  });

  // Reads through a resolver or subregistries the name chooses.
  it.each([
    ['an addr record', at(RESOLVER, 'addr'), (svc: BlockchainService) => svc.getAddr('sepolia', RESOLVER, NODE)],
    ['a contenthash', at(RESOLVER, 'contenthash'), (svc: BlockchainService) => svc.getContenthash('sepolia', RESOLVER, NODE)],
    ['the UR resolver walk', at(UR, 'findResolver'), (svc: BlockchainService) => svc.getResolverV2('sepolia', 'sub.name.eth')],
    ['the registry walk', at(SUBREGISTRY, 'getSubregistry'), (svc: BlockchainService) => svc.getResolverHierarchical('sepolia', 'sub.name.eth')],
    ['the UR owner walk', at(UR, 'findOwner'), (svc: BlockchainService) => svc.getV2NameRecord('sepolia', 'sub.name.eth')],
  ])('never marks it when %s times out', async (_, slow, read) => {
    let slowCalls = 0;
    stubFetch({ [lone]: ensNode({ [slow]: (init) => { slowCalls++; return hang(init); } }) });
    const svc = new BlockchainService(env);

    const out = await settle(inRequest(DEADLINE_MS, async () => {
      await read(svc).catch(() => {});
      return svc.getOwner('sepolia', NODE);
    }), 60_000);

    expect(slowCalls).toBeGreaterThan(0);
    expect(out.error).toBeUndefined();
    expect(out.value).toBe(OWNER);
  });
});

describe('CCIP gateway fetch under the request deadline', () => {
  const SENDER = '0x1111111111111111111111111111111111111111' as const;
  const GATEWAY = 'https://gateway.example/{data}';
  const OK_RESPONSE = '0x01';
  function okResponse(): Response {
    return new Response(OK_RESPONSE, { headers: { 'content-type': 'text/plain' } });
  }
  function redirect(location: string, status = 301): Response {
    return new Response(null, { status, headers: { Location: location } });
  }

  // ── initial-hop gate (existing, preserved) ──────────────────────────────

  it('does not start an initial gateway fetch with less than 1s left', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    // 500ms left: well under MIN_UPSTREAM_ATTEMPT_MS (1000ms).
    const out = await settle(inRequest(500, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    expectDeadlineError(out.error);
    expect(out.elapsed).toBeLessThanOrEqual(50);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── redirect-hop gates: every hop is an attempt ───────────────────────

  it('gates redirect hops: a 2ms redirect from 1001ms leaves 999ms and the redirect hop is rejected before any charge or fetch', async () => {
    // 1001ms remaining. The initial gateway answers after 2ms with a redirect.
    // By the time the redirect hop starts the request has 999ms left, under
    // the 1000ms floor. The redirect hop must be rejected before any charge
    // or fetch.
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (called.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('/hop2')), 2);
        });
      }
      return okResponse();
    }));

    const out = await settle(inRequest(1001, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    // RED on HEAD 80f8ba3: the redirect hop succeeds (out.value '0x01',
    // out.error undefined) because timeLeftForAttempt is only called once
    // before fetchMediaUrl, not per hop.
    expectDeadlineError(out.error);
    // Only the initial URL was fetched; the redirect hop was rejected.
    expect(called).toEqual(['https://gateway.example/0x01']);
  });

  it('permits a redirect hop that starts with 1001ms remaining (no time lost on the first response)', async () => {
    // Both hops resolve synchronously: the redirect hop still has 1001ms.
    const fetchMock = vi.fn()
      .mockReturnValueOnce(redirect('/hop2'))
      .mockReturnValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const out = await settle(inRequest(1001, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    // RED on HEAD: succeeds either way (current code doesn't gate redirects
    // at all), so this assertion passes whether or not the redirect hop is
    // properly gated. The test above is the gate; this one is the
    // non-regression.
    expect(out.error).toBeUndefined();
    expect(out.value).toBe(OK_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect hop at exactly 1000ms remaining', async () => {
    // MIN_UPSTREAM_ATTEMPT_MS = 1000. At exactly 1000ms the attempt is
    // still >= MIN, so it is permitted. But after a 1ms first response the
    // redirect hop sees 999ms and is rejected.
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (called.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('/hop2')), 1);
        });
      }
      return okResponse();
    }));

    const out = await settle(inRequest(1000, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    expectDeadlineError(out.error);
    expect(called).toEqual(['https://gateway.example/0x01']);
  });

  // ── relative & absolute redirect targets ───────────────────────────────

  it('gates redirect hops to a relative Location (e.g. /hop2)', async () => {
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (called.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('/hop2')), 2);
        });
      }
      return okResponse();
    }));

    const out = await settle(inRequest(1001, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    expectDeadlineError(out.error);
    // Relative Location resolved against the gateway origin.
    expect(called).toEqual(['https://gateway.example/0x01']);
  });

  it('gates redirect hops to an absolute Location on a different host', async () => {
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (called.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('https://other.example/hop2')), 2);
        });
      }
      return okResponse();
    }));

    const out = await settle(inRequest(1001, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    expectDeadlineError(out.error);
    expect(called).toEqual(['https://gateway.example/0x01']);
  });

  // ── configured-gateway fallback ────────────────────────────────────────

  it('falls back to the next configured gateway after a redirect hop is deadline-killed', async () => {
    // First configured URL: initial fetch takes 2ms and redirects.
    // The redirect hop is deadline-killed (999ms left).
    // The next configured URL has a fresh 25s and succeeds.
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (url === 'https://gateway.example/0x01') {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('/hop2')), 2);
        });
      }
      return okResponse();
    }));

    const out = await settle(inRequest(1001, () =>
      guardedCcipRequest({
        data: '0x01',
        sender: SENDER,
        urls: [GATEWAY, 'https://gw2.example/{data}'],
      }),
    ), 60_000);

    // RED on HEAD: the first URL's redirect succeeds (no redirect gating),
    // the function returns 0x01 from the redirect hop, and gw2 is never
    // tried.
    expect(out.error).toBeUndefined();
    expect(out.value).toBe(OK_RESPONSE);
    // First URL's initial fetch + second URL fetches (no redirect hop).
    expect(called).toEqual(['https://gateway.example/0x01', 'https://gw2.example/0x01']);
  });

  // ── deadline-before-charge ordering ────────────────────────────────────

  it('initial hop at 999ms: deadline check before charge — takeCcipRequest is never called', async () => {
    // Spend 30 of 32 charges first. Then enter with 999ms remaining.
    // The deadline check must fire before the charge, so takeCcipRequest
    // stays at 30. This is already true on HEAD for the initial hop
    // (the outer timeLeftForAttempt gates it); the redirect-hop ordering
    // gap is tested separately below.
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    let chargesAfter = -1;
    let error: unknown;
    await settle(inRequest(999, async () => {
      for (let i = 0; i < 30; i++) takeCcipRequest();
      try {
        await guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] });
      } catch (err) {
        error = err;
        chargesAfter = 30;
        while (takeCcipRequest()) chargesAfter++;
      }
    }), 60_000);

    expectDeadlineError(error);
    // 30 pre-spent + 2 remaining unconsumed (MAX is 32) = 32.
    // No charge was taken by the rejected attempt.
    expect(chargesAfter).toBe(32);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirect hop: checks deadline before charge — at 999ms the allowance is untouched', async () => {
    // Pre-spend 30 charges, then trigger a redirect with time passage.
    // The redirect hop sees 999ms. The deadline check must fire before
    // chargeGatewayFetch, so takeCcipRequest stays at 30.
    // If chargeGatewayFetch runs first, it hits 31: wrong taxonomy.
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (called.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('/hop2')), 2);
        });
      }
      return okResponse();
    }));

    let chargesAfter = -1;
    let error: unknown;
    await settle(inRequest(1001, async () => {
      for (let i = 0; i < 30; i++) takeCcipRequest();
      try {
        await guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] });
      } catch (err) {
        error = err;
        chargesAfter = 30;
        while (takeCcipRequest()) chargesAfter++;
      }
    }), 60_000);

    // RED on HEAD 80f8ba3: the redirect hop is not deadline-gated.
    // chargeGatewayFetch runs the charge first (31), fetch follows,
    // guardedCcipRequest returns 0x01. error stays undefined, chargesAfter
    // stays -1. After the fix the redirect hop is gated:
    // RequestDeadlineError fires before charging — chargesAfter is 30.
    expectDeadlineError(error);
    // 30 pre-spent + 2 remaining unconsumed (MAX is 32) = 32.
    // No charge was taken by the rejected redirect hop.
    expect(chargesAfter).toBe(32);
    expect(called).toEqual(['https://gateway.example/0x01']);
  });

  // ── RequestDeadlineError taxonomy preservation ─────────────────────────

  it('preserves RequestDeadlineError through the surrounding catch (not wrapped as CcipGatewayError)', async () => {
    // When a redirect hop is deadline-killed, the error must escape
    // guardedCcipRequest's catch block unchanged. Otherwise callers
    // misclassify it as a gateway failure.
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      called.push(url);
      if (called.length === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(redirect('/hop2')), 2);
        });
      }
      return okResponse();
    }));

    const out = await settle(inRequest(1001, () =>
      guardedCcipRequest({ data: '0x01', sender: SENDER, urls: [GATEWAY] }),
    ), 60_000);

    // RED on HEAD: same as the redirect-gating test — the redirect hop
    // succeeds and returns 0x01. After the fix, the error is
    // RequestDeadlineError, NOT CcipGatewayError.
    expectDeadlineError(out.error);
    // Double-check: explicitly not a CcipGatewayError.
    if (out.error) {
      expect(out.error).not.toBeInstanceOf(CcipGatewayError);
      expect((out.error as Error).name).toBe('RequestDeadlineError');
    }
    expect(called).toEqual(['https://gateway.example/0x01']);
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
