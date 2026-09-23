import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';
import { registerLogSecrets, redactText, redactValue, wrapConsole } from '../src/utils/log-redaction';
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

// Everything a logged argument could expose: message, stack, cause chain and
// own enumerable properties.
function rendered(args: unknown[]): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (v instanceof Error) {
      parts.push(v.name, v.message, v.stack ?? '');
      for (const [k, val] of Object.entries(v)) parts.push(k, String(val));
      if (depth < 6) walk((v as { cause?: unknown }).cause, depth + 1);
    } else if (typeof v === 'object' && v !== null) {
      parts.push(JSON.stringify(v));
    } else if (v !== undefined) {
      parts.push(String(v));
    }
  };
  for (const a of args) walk(a, 0);
  return parts.join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('redaction primitives', () => {
  registerLogSecrets([SECRET_URL, undefined, '']);

  it('redacts the full secret URL and its path on its own', () => {
    expect(redactText(`URL: ${SECRET_URL}`)).toBe('URL: [redacted]');
    expect(redactText(`POST /v2/${KEY} failed`)).not.toContain(KEY);
  });

  it('leaves public URLs and ordinary text alone', () => {
    const text = 'Client 1 failed for mainnet: https://rpc.ankr.com/eth timed out for fox.eth';
    expect(redactText(text)).toBe(text);
  });

  it('rebuilds errors without the secret in message, stack, cause chain or extra fields', () => {
    const inner = Object.assign(new Error(`HTTP request failed.\n\nURL: ${SECRET_URL}`), { url: SECRET_URL, details: 'fetch failed' });
    const outer = new UpstreamError(`All RPC clients failed for mainnet. Last error: ${inner.message}`, { cause: inner });
    const out = redactValue(outer) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe('UpstreamError');
    expect(rendered([out])).not.toContain(KEY);
    expect(out.message).toContain('All RPC clients failed for mainnet');
  });

  it('redacts plain objects that contain a secret', () => {
    expect(JSON.stringify(redactValue({ rpc: SECRET_URL, n: 1 }))).not.toContain(KEY);
  });

  it('wrapConsole redacts every argument of every method', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const target = { ...sink };
    wrapConsole(target);
    target.warn('rpc failed:', new Error(`URL: ${SECRET_URL}`));
    target.error({ url: SECRET_URL });
    target.log(`calling ${SECRET_URL}`);
    const all = [...sink.warn.mock.calls, ...sink.error.mock.calls, ...sink.log.mock.calls].flat();
    expect(rendered(all)).not.toContain(KEY);
  });
});

describe('a real viem RPC failure logged by BlockchainService', () => {
  // Runs before anything wraps the global console in this file.
  it('control: without redaction the provider key reaches the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const svc = new BlockchainService({ MAINNET_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' });
    await svc.executeWithFallback('mainnet', (client) => client.getBlockNumber()).catch(() => {});
    expect(rendered(warn.mock.calls.flat())).toContain(KEY);
  }, 30_000);

  it('logs no provider key once the console is wrapped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wrapConsole(console);
    registerLogSecrets([SECRET_URL]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    const svc = new BlockchainService({ MAINNET_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' });
    const failure = await svc
      .executeWithFallback('mainnet', (client) => client.getBlockNumber())
      .catch((e: unknown) => e);

    // The primary client's failure is logged (the control test above shows that
    // line carries the key when unredacted), yet no logged text contains it.
    expect(failure).toBeInstanceOf(UpstreamError);
    const primaryFailureLog = warn.mock.calls.find((call) => String(call[0]).startsWith('Client 0 failed'));
    expect(primaryFailureLog).toBeDefined();
    expect(rendered(warn.mock.calls.flat())).not.toContain(KEY);
  }, 30_000);
});

describe('the Worker registers its secret bindings on every request', () => {
  it('redacts the RPC URL bindings from logs once a request has been served', async () => {
    const SEPOLIA_KEY = 'ZyXwVuTsRqPoNmLk98765';
    const sepoliaUrl = `https://sepolia.infura.io/v3/${SEPOLIA_KEY}`;
    const { default: app } = await import('../src/index');
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await app.request('/', undefined, { ...createMockEnv(), SEPOLIA_RPC_URL: sepoliaUrl } as unknown as Record<string, unknown>, ctx);
    expect(redactText(`URL: ${sepoliaUrl}`)).toBe('URL: [redacted]');
  });
});
