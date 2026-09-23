import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { inspect } from 'node:util';
import { createMockEnv } from './mocks/hono-env';
import { registerLogSecrets, redactText, formatRedacted, wrapConsole } from '../src/utils/log-redaction';
import { BlockchainService } from '../src/services/blockchain';
import { UpstreamError } from '../src/services/errors';

// Regression (WEB-1548 / WEB-1554): viem copies the full RPC request URL into its
// transport errors, and those errors were logged verbatim, so the provider key in
// MAINNET_RPC_URL / SEPOLIA_RPC_URL (both secrets) was written to Workers Logs on
// every RPC failure.

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

const KEY = 'AbCdEfGhIjKlMnOpQrStUvWx1234';
const SECRET_URL = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;

// Everything the runtime could print or capture for the arguments a sink got.
const everything = (args: unknown[]) =>
  args.map((a) => (typeof a === 'string' ? a : inspect(a, { showHidden: true, depth: Infinity, getters: true }))).join('\n');

function sinkConsole() {
  const sink = {
    debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
    group: vi.fn(), groupCollapsed: vi.fn(), assert: vi.fn(), dir: vi.fn(), dirxml: vi.fn(), table: vi.fn(),
  };
  const target = { ...sink };
  wrapConsole(target);
  return { sink, target };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Runs first: nothing is registered yet in this file.
describe('before any secret is registered', () => {
  it('passes arguments through unchanged', () => {
    const { sink, target } = sinkConsole();
    const err = new Error('boom');
    const obj = { a: 1 };
    target.warn('x', err, obj);
    expect(sink.warn).toHaveBeenCalledWith('x', err, obj);
  });
});

describe('redaction', () => {
  beforeAll(() => registerLogSecrets([SECRET_URL, undefined, '']));

  it('redacts the full secret URL and its path on its own', () => {
    expect(redactText(`URL: ${SECRET_URL}`)).toBe('URL: [redacted]');
    expect(redactText(`POST /v2/${KEY} failed`)).not.toContain(KEY);
  });

  it('leaves public URLs and ordinary text alone', () => {
    const text = 'Client 1 failed for mainnet: https://rpc.ankr.com/eth timed out for fox.eth';
    expect(redactText(text)).toBe(text);
  });

  it('every text method receives exactly one redacted string', () => {
    const { sink, target } = sinkConsole();
    for (const m of ['debug', 'info', 'log', 'warn', 'error', 'trace', 'group', 'groupCollapsed'] as const) {
      target[m](`${m} failed:`, new Error(`URL: ${SECRET_URL}`), { rpc: SECRET_URL });
      const call = sink[m].mock.calls[0];
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('string');
      expect(call[0]).toContain(`${m} failed:`);
      expect(call[0]).not.toContain(KEY);
    }
  });

  it.each([
    ['an error with a cause chain and extra fields', () =>
      new UpstreamError('All RPC clients failed', { cause: Object.assign(new Error(`HTTP request failed. URL: ${SECRET_URL}`), { url: SECRET_URL }) })],
    ['AggregateError.errors', () => new AggregateError([new Error(`URL: ${SECRET_URL}`)], 'all RPCs failed')],
    ['Headers', () => new Headers({ authorization: `Bearer ${KEY}`, 'x-rpc': SECRET_URL })],
    ['a Response whose url is the secret', () => { const r = new Response('x'); Object.defineProperty(r, 'url', { value: SECRET_URL }); return r; }],
    ['a class instance holding an Error', () => new (class Attempt { constructor(public lastError: Error) {} })(new Error(`URL: ${SECRET_URL}`))],
    ['a class instance holding a Map', () => new (class Pool { clients = new Map([[0, SECRET_URL]]); })()],
    ['a symbol-keyed property', () => ({ [Symbol('rpc')]: SECRET_URL })],
    ['a named property on an array', () => Object.assign([1, 2], { rpc: SECRET_URL })],
    ['an error whose stack is not a string', () => { const e = new Error('x'); Object.defineProperty(e, 'stack', { value: { url: SECRET_URL } }); return e; }],
    ['an object whose toString returns the secret', () => ({ toString: () => SECRET_URL })],
    ['a circular object with a BigInt', () => { const o: Record<string, unknown> = { n: 42n, rpc: SECRET_URL }; o.self = o; return o; }],
    ['a URL and a Request', () => [new URL(SECRET_URL), new Request(SECRET_URL)]],
  ])('%s', (_label, make) => {
    const { sink, target } = sinkConsole();
    const value = make();
    target.warn('%s', value);
    target.error('x', value);
    target.dir(value);
    target.table([value]);
    const out = everything([...sink.warn.mock.calls.flat(), ...sink.error.mock.calls.flat(), ...sink.dir.mock.calls.flat(), ...sink.table.mock.calls.flat()]);
    expect(out).not.toContain(KEY);
  });

  it('console.assert keeps its condition, and a formatting failure never flips it', () => {
    const { sink, target } = sinkConsole();
    target.assert(false, `URL: ${SECRET_URL}`);
    target.assert(true, 'fine');
    const throwing = { [inspect.custom]: () => { throw new Error('nope'); } };
    target.assert(false, throwing);
    expect(sink.assert.mock.calls.map((c) => c[0])).toEqual([false, true, false]);
    expect(everything(sink.assert.mock.calls.flat())).not.toContain(KEY);
  });

  it('never throws into the caller', () => {
    const { sink, target } = sinkConsole();
    const throwing = { [inspect.custom]: () => { throw new Error('nope'); } };
    expect(() => target.warn('x', throwing)).not.toThrow();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(formatRedacted([throwing])).toContain('log line dropped');
  });

  it('stays cheap for large binary and array arguments', () => {
    const { target } = sinkConsole();
    const t = performance.now();
    target.warn('big', new Uint8Array(4 * 1024 * 1024), new Array(1_000_000).fill('x'));
    expect(performance.now() - t).toBeLessThan(250);
  });

  it('a second copy of the module shares the registry of the installed wrapper', async () => {
    const { sink, target } = sinkConsole();
    vi.resetModules();
    const second = await import('../src/utils/log-redaction');
    const OTHER = 'https://second.example/v2/SecondModuleKey123456';
    second.registerLogSecrets([OTHER]);
    target.warn(`URL: ${OTHER}`);
    expect(everything(sink.warn.mock.calls.flat())).not.toContain('SecondModuleKey123456');
  });
});

describe('a real viem RPC failure logged by BlockchainService', () => {
  // Runs before anything wraps the global console in this file.
  it('control: without redaction the provider key reaches the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const svc = new BlockchainService({ MAINNET_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' });
    await svc.executeWithFallback('mainnet', (client) => client.getBlockNumber()).catch(() => {});
    expect(everything(warn.mock.calls.flat())).toContain(KEY);
  }, 30_000);

  it('logs no provider key once the console is wrapped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wrapConsole(console);
    registerLogSecrets([SECRET_URL]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    const svc = new BlockchainService({ MAINNET_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' });
    const failure = await svc.executeWithFallback('mainnet', (client) => client.getBlockNumber()).catch((e: unknown) => e);

    // The primary client's failure is logged (the control test above shows that
    // line carries the key when unredacted), yet no logged text contains it.
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('Client 0 failed'))).toBe(true);
    expect(everything(warn.mock.calls.flat())).not.toContain(KEY);
  }, 30_000);
});

describe('the Worker registers its secret bindings on every request', () => {
  it('redacts the RPC URL and webhook secret bindings once a request has been served', { timeout: 60_000 }, async () => {
    const SEPOLIA_KEY = 'ZyXwVuTsRqPoNmLk98765';
    const sepoliaUrl = `https://sepolia.infura.io/v3/${SEPOLIA_KEY}`;
    const webhookSecret = 'f'.repeat(64);
    const { default: app } = await import('../src/index');
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await app.request('/', undefined, { ...createMockEnv(), SEPOLIA_RPC_URL: sepoliaUrl, WEBHOOK_SECRET: webhookSecret } as unknown as Record<string, unknown>, ctx);
    expect(redactText(`URL: ${sepoliaUrl}`)).toBe('URL: [redacted]');
    expect(redactText(`secret ${webhookSecret}`)).toBe('secret [redacted]');
  });
});

describe('key fragments', () => {
  it('redacts a long path segment or query value on its own, not short public ones', () => {
    registerLogSecrets(['https://rpc.example.com/mainnet/v3/Qk2Lm9Xa0Pq7Rt5YsZ1B', 'https://rpc2.example.com/rpc?apikey=ApiKeyValue1234567890&chain=eth']);
    expect(redactText('invalid key Qk2Lm9Xa0Pq7Rt5YsZ1B')).toBe('invalid key [redacted]');
    expect(redactText('Bearer ApiKeyValue1234567890')).toBe('Bearer [redacted]');
    expect(redactText('mainnet v3 eth')).toBe('mainnet v3 eth');
  });
});

describe('round-3 hardening', () => {
  it('a secret deep inside a long nested string is redacted, not truncated into a readable prefix', () => {
    const { sink, target } = sinkConsole();
    const pad = 'x'.repeat(9_990);
    target.warn('Client 0 failed for mainnet:', { details: `${pad}${SECRET_URL} tail` });
    target.dir(`${pad}${SECRET_URL}`);
    const out = everything([...sink.warn.mock.calls.flat(), ...sink.dir.mock.calls.flat()]);
    expect(out).not.toContain(KEY.slice(0, 8));
  });

  it('short and percent-encoded query keys are redacted in every field of a logged URL', () => {
    const short = 'https://rpc.example.com/rpc?apikey=Sh0rtKey1234';
    const encoded = 'https://rpc2.example.com/rpc?key=AbCdEf%2BGhIjKlMnOpQr';
    registerLogSecrets([short, encoded]);
    const text = formatRedacted(['rpc:', new URL(short), new URL(encoded)]);
    expect(text).not.toContain('Sh0rtKey1234');
    expect(text).not.toContain('AbCdEf%2BGhIjKlMnOpQr');
    expect(text).not.toContain('AbCdEf+GhIjKlMnOpQr');
  });
});
