import { describe, it, expect, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Regression: GET /:network/avatar/:name/meta returns the avatar record's JSON
// with its extra fields as-is, so its nesting is chosen by the name's owner.
// The global ?pretty middleware re-indented it, and indentation grows with
// depth: 8 KB of nested arrays became a 32 MB response string, re-expanded on
// every request (also from the edge cache). The same held for avatar/header
// media served as JSON and for POST /batch-metadata, which echoes each name.

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

let deep: unknown = 'x';
for (let i = 0; i < 4000; i++) deep = [deep];
// Media whose declared type is JSON (a data: URI or remote Content-Type).
const deepJsonMedia = () => ({ buffer: Buffer.from(JSON.stringify(deep)), mimeType: 'application/json' });

vi.mock('../src/services/avatar', () => ({
  AvatarService: class {
    async getAvatarMeta() { return { uri: 'evil.eth', image: 'https://cdn.example/a.png', a: deep }; }
    async getAvatarImage() { return deepJsonMedia(); }
    async getHeaderImage() { return deepJsonMedia(); }
    async getAvatarBase64() { return null; }
  },
}));

import app from '../src/index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

describe('?pretty on owner-shaped JSON', () => {
  it('the avatar meta route is not re-indented', async () => {
    const plain = await (await req('/mainnet/avatar/evil.eth/meta')).text();
    const pretty = await (await req('/mainnet/avatar/evil.eth/meta?pretty')).text();
    expect(plain.length).toBeLessThan(20_000);
    expect(pretty.length).toBe(plain.length);
  });

  for (const path of ['/mainnet/avatar/evil.eth', '/mainnet/header/evil.eth']) {
    it(`${path} is not re-indented`, async () => {
      const plain = await (await req(path)).text();
      const pretty = await (await req(`${path}?pretty`)).text();
      expect(plain.length).toBeLessThan(20_000);
      expect(pretty.length).toBe(plain.length);
    });
  }

  it('POST /batch-metadata rejects names that are not strings instead of echoing them', async () => {
    const res = await app.request(
      '/batch-metadata?pretty',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['nick.eth', deep] }) },
      createMockEnv() as unknown as Record<string, unknown>,
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.text()).length).toBeLessThan(1_000);
  });

  it('other routes still honor ?pretty', async () => {
    const body = await (await req('/?pretty')).text();
    expect(body).toContain('\n  "service"');
  });
});
