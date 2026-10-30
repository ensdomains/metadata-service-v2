import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarResolver } from '@ensdomains/ens-avatar';
import { createMockEnv } from './mocks/hono-env';
import app from '../src/index';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const OVER_DEFAULT = Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024 + 1 - PNG.length)]);

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

async function request(path: string, maxAvatarBytes: string): Promise<Response> {
  const env = {
    ...createMockEnv(),
    RATE_LIMIT_DISABLED: 'true',
    MAX_AVATAR_BYTES: maxAvatarBytes,
  };
  return app.request(path, undefined, env as unknown as Record<string, unknown>, executionContext());
}

describe('MAX_AVATAR_BYTES configuration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a numeric prefix and retains both the default and explicit size caps', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(AvatarResolver.prototype, 'getAvatar').mockImplementation(async (name) =>
      `https://media.example/${name}.png`,
    );
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const body = url.includes('over-default.eth') ? OVER_DEFAULT : PNG;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': body.length.toString(),
        },
      });
    }));

    // Mainnet's service is first constructed with the garbage value. It must
    // use AvatarService's default cap rather than parse the numeric prefix as 1.
    const valid = await request('/mainnet/avatar/red-team.eth', '1a');
    const overDefault = await request('/mainnet/avatar/over-default.eth', '1a');

    // A separately cached network service proves valid whole integers still cap
    // media at the configured byte count.
    const overExplicit = await request('/sepolia/avatar/explicit-cap.eth', '2');

    expect.soft(valid.status).toBe(200);
    expect.soft(Buffer.from(await valid.arrayBuffer())).toEqual(PNG);
    expect.soft(overDefault.status).toBe(404);
    expect.soft(overExplicit.status).toBe(404);
  });
});
