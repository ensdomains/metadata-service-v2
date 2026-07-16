import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Configurable behavior for the mocked AvatarService.getAvatarMeta. Declared
// before vi.mock so the hoisted factory can close over it.
const avatarMetaMock = vi.fn();

// Mock rasterize to avoid WASM import issues in Vite (mirrors test/index.test.ts).
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

// Mock the avatar service so the route can be exercised without any RPC/network.
// The constructor ignores its args; only the methods the routes call are stubbed.
vi.mock('../src/services/avatar', () => ({
  AvatarService: class {
    getAvatarMeta(...args: unknown[]) {
      return avatarMetaMock(...args);
    }
    async getAvatarImage() {
      return null;
    }
    async getHeaderImage() {
      return null;
    }
    async getAvatarBase64() {
      return null;
    }
  },
}));

import app from '../src/index';

// Drive the real app with a mock CF env + execution context (Hono builds the
// request URL from the path, so `c.req.url` → http://localhost<path>).
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) =>
  app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

describe('GET /:network/avatar/:name/meta', () => {
  beforeEach(() => {
    avatarMetaMock.mockReset();
  });

  it('returns 200 + the avatar metadata JSON when a record resolves', async () => {
    const meta = {
      uri: 'nick.eth',
      name: 'Cool NFT #1',
      image: 'https://cdn.test/1.png',
      image_url: 'https://cdn.test/1.png',
      is_owner: true,
      host_meta: { chain_id: 1, contract_address: '0xabc', token_id: '1' },
    };
    avatarMetaMock.mockResolvedValue(meta);

    const res = await req('/mainnet/avatar/nick.eth/meta');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toMatchObject(meta);

    // Handler passes the name + this deployment's avatar image URL (for the
    // image_data → image fallback).
    expect(avatarMetaMock).toHaveBeenCalledWith(
      'nick.eth',
      expect.stringContaining('/mainnet/avatar/nick.eth'),
    );
  });

  it('returns 404 "No results found." when there is no avatar record', async () => {
    avatarMetaMock.mockResolvedValue(null);

    const res = await req('/sepolia/avatar/none.eth/meta');
    expect(res.status).toBe(404);

    const data = (await res.json()) as Record<string, unknown>;
    expect(data.message).toBe('No results found.');
  });

  it('is a distinct route — does NOT fall through to the generic 404 handler', async () => {
    avatarMetaMock.mockResolvedValue(null);
    const res = await req('/mainnet/avatar/nick.eth/meta');
    const data = (await res.json()) as Record<string, unknown>;
    // The catch-all notFound returns { error: "Not Found" }; the avatar-meta route
    // returns the v1 { message: "No results found." } shape instead.
    expect(data.error).toBeUndefined();
    expect(data.message).toBe('No results found.');
    expect(avatarMetaMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid network with 400 before touching the service', async () => {
    const res = await req('/nope/avatar/nick.eth/meta');
    expect(res.status).toBe(400);
    expect(avatarMetaMock).not.toHaveBeenCalled();
  });

  it('does not shadow the 3-segment avatar image route', async () => {
    // /:network/avatar/:name (no /meta) must resolve the image, never getAvatarMeta.
    const res = await req('/mainnet/avatar/nick.eth');
    expect(res.status).toBe(404); // getAvatarImage mock → null → "No avatar set"
    expect(avatarMetaMock).not.toHaveBeenCalled();
  });
});
