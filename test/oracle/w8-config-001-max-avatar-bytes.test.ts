import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../mocks/hono-env';

// Blind acceptance test for W8-CONFIG-001. MAX_AVATAR_BYTES="1a" must not become
// a 1-byte cap. Garbage falls back to AvatarService's 25 MiB default, so a
// valid avatar larger than one byte is served and a body over 25 MiB is not.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DEFAULT_CAP = 25 * 1024 * 1024;

function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_MAGIC);
  return bytes;
}

async function avatar(maxAvatarBytes: string | undefined, body: Uint8Array): Promise<Response> {
  vi.resetModules();
  const { default: app } = await import('../../src/index');
  const { AvatarResolver } = await import('@ensdomains/ens-avatar');
  vi.spyOn(AvatarResolver.prototype, 'getAvatar').mockResolvedValue('https://cdn.example/red-team.png');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from(body), { headers: { 'content-type': 'image/png' } })));
  const env = {
    ...createMockEnv(),
    RATE_LIMIT_DISABLED: 'true',
    ...(maxAvatarBytes === undefined ? {} : { MAX_AVATAR_BYTES: maxAvatarBytes }),
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return app.request('/mainnet/avatar/red-team.eth', undefined, env as unknown as Record<string, unknown>, ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('MAX_AVATAR_BYTES garbage falls back to the 25 MiB default', () => {
  it('serves a valid avatar larger than one byte when MAX_AVATAR_BYTES is "1a"', async () => {
    const body = png(PNG_MAGIC.length);
    const res = await avatar('1a', body);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it('still discards a body larger than 25 MiB when MAX_AVATAR_BYTES is "1a"', async () => {
    const res = await avatar('1a', png(DEFAULT_CAP + 1));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'No avatar set for red-team.eth' });
  });

  it('serves a body of exactly 25 MiB when MAX_AVATAR_BYTES is "1a"', async () => {
    const body = png(DEFAULT_CAP);
    const res = await avatar('1a', body);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(DEFAULT_CAP);
  });

  it('still honors a usable integer cap', async () => {
    const res = await avatar('2', png(PNG_MAGIC.length));
    expect(res.status).toBe(404);
  });

  it('rejects an unsafe integer and falls back to the default cap', async () => {
    // "9007199254740993" rounds to 9007199254740992 under IEEE-754;
    // the parser must treat it as garbage and use the 25 MiB default.
    const overDefault = png(DEFAULT_CAP + 1);
    const res = await avatar('9007199254740993', overDefault);
    expect(res.status).toBe(404);
  });
});
