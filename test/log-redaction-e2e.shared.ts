import { expect, vi } from 'vitest';
import { inspect } from 'node:util';
import { createMockEnv } from './mocks/hono-env';

// Shared by the end-to-end redaction test and its control. Console sinks are
// installed BEFORE src/index is imported, so the Worker's wrapper wraps them
// and the sinks receive exactly what would reach Workers Logs.

export const MKEY = 'MainKeyAbCdEfGh0123456789Zz';
export const SKEY = 'SepKeyZyXwVu9876543210Qq';
export const WEBHOOK = 'a'.repeat(8) + 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8';
// Uppercase host: runtimes print the normalized (lowercased) URL, so only the
// path fragment of the registered secret matches.
const MAINNET = `https://ETH-Mainnet.g.alchemy.com/v2/${MKEY}`;
const SEPOLIA = `https://sepolia.infura.io/v3/${SKEY}`;

export function captureConsole(): Array<{ m: string; args: unknown[] }> {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  for (const m of ['debug', 'info', 'log', 'warn', 'error', 'trace', 'dir', 'table', 'group', 'groupCollapsed', 'assert'] as const) {
    (console as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => { calls.push({ m, args }); };
  }
  return calls;
}

export async function driveRoutesWithFailingUpstreams(calls: Array<{ m: string; args: unknown[] }>): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const u = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    throw new TypeError(`Network connection lost: ${new URL(u).href}`);
  }));
  const { default: app } = await import('../src/index');
  const env = { ...createMockEnv(), MAINNET_RPC_URL: MAINNET, SEPOLIA_RPC_URL: SEPOLIA, WEBHOOK_SECRET: WEBHOOK, RATE_LIMIT_DISABLED: 'true' };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  for (const p of [
    '/mainnet/avatar/nick.eth',
    '/mainnet/avatar/nick.eth/meta',
    '/sepolia/avatar/nick.eth',
    '/mainnet/0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85/42',
    '/sepolia/registry/nick.eth',
    '/migration-status/nick.eth',
    '/registry-hierarchy/nick.eth',
    '/health',
  ]) {
    await app.request(p, undefined, env as unknown as Record<string, unknown>, ctx);
  }
  const dump = calls
    .map((c) => `${c.m}: ` + c.args.map((a) => (typeof a === 'string' ? a : inspect(a, { showHidden: true, depth: Infinity }))).join(' '))
    .join('\n');
  // The RPC failure path really ran and logged.
  expect(dump).toMatch(/Client 0 failed/);
  return dump;
}
