import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Mock rasterize to avoid WASM import issues in Vite (mirrors test/index.test.ts).
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { InvalidNameError } from '../src/services/errors';
import { isResolvableEnsName, namehash } from '../src/utils/ens';

// A malformed ENS name is a CLIENT error. The avatar/header/migration-status/
// hierarchy routes already 400 via validateEnsNameParam, but the metadata, image
// and rasterize routes skipped that middleware and let the service's plain
// `Error('Invalid ENS name format')` reach the route mapper — which flattened it
// to a generic 500 "Failed to resolve metadata".

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) =>
  app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

async function expect400(path: string) {
  const res = await req(path);
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.error).toBe('Invalid ENS name format');
}

describe('malformed ENS names are rejected with 400 at the route boundary', () => {
  it('GET /:network/registry/:name (no TLD)', () => expect400('/mainnet/registry/notaname'));
  it('GET /:network/namewrapper/:name (empty label)', () => expect400('/mainnet/namewrapper/.eth'));
  it('GET /:network/registry/:name/image', () => expect400('/sepolia/registry/notaname/image'));
  it('GET /:network/registry/:name/rasterize', () => expect400('/sepolia/registry/notaname/rasterize'));
});

describe('MetadataService throws the typed InvalidNameError (not a plain Error)', () => {
  function makeService(): MetadataService {
    return new MetadataService(
      {
        indexerV2Endpoint: 'https://zigens.test/graphql',
        indexerV2ApiVersion: 'v1',
        network: 'mainnet',
        fallbackToBlockchain: true,
        internalCacheEnabled: false,
        d1Enabled: false,
      },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
  }

  it('getMetadata', async () => {
    await expect(makeService().getMetadata('mainnet', 'registry', 'notaname')).rejects.toBeInstanceOf(InvalidNameError);
  });
  it('getMigrationStatus', async () => {
    await expect(makeService().getMigrationStatus('notaname')).rejects.toBeInstanceOf(InvalidNameError);
  });
  it('getRegistryHierarchy', async () => {
    await expect(makeService().getRegistryHierarchy('notaname')).rejects.toBeInstanceOf(InvalidNameError);
  });
  it('resolveStatusForImage', async () => {
    await expect(makeService().resolveStatusForImage('mainnet', 'notaname')).rejects.toBeInstanceOf(InvalidNameError);
  });
  it('InvalidNameError is a distinct Error subclass with a stable name', () => {
    const err = new InvalidNameError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidNameError');
    expect(err.message).toBe('Invalid ENS name format');
  });
});

// A name ENSIP-15 rejects passes validateEnsName's shape checks, but the lookups'
// namehash (ensjs, which normalizes each label) throws on it, so it can never
// resolve here. It used to fail inside the fallback chain and come back as an
// outage (503); it is a 400. Names that normalize to another form, and encoded
// labelhashes, are still looked up.
describe('names the lookups cannot hash are rejected with 400', () => {
  // In URL form (percent-encoded where needed): ':', '_' inside a label, '/',
  // a space, NUL, a dangling ZWJ.
  const UNRESOLVABLE = ['bad:.eth', 'a_b.eth', 'a%2Fb.eth', 'a%20b.eth', 'x%00y.eth', '%F0%9F%91%A8%E2%80%8D.eth'];
  const RESOLVABLE = ['Nick.eth', '%F0%9F%92%A9%F0%9F%92%A9.eth', `[${'ab'.repeat(32)}].eth`, 'sub.nick.eth', '_underscore.eth'];

  it.each(UNRESOLVABLE)('%s: not resolvable, and the lookup namehash does throw on it', (raw) => {
    const name = decodeURIComponent(raw);
    expect(isResolvableEnsName(name)).toBe(false);
    expect(() => namehash(name.toLowerCase())).toThrow();
  });

  it.each(RESOLVABLE)('%s: resolvable', (raw) => {
    expect(isResolvableEnsName(decodeURIComponent(raw))).toBe(true);
  });

  it.each(UNRESOLVABLE.flatMap((name) => ['mainnet', 'sepolia'].flatMap((net) =>
    ['', '/image', '/rasterize'].map((suffix) => `/${net}/registry/${name}${suffix}`))))(
    'GET %s → 400',
    (path) => expect400(path),
  );

  it.each(UNRESOLVABLE)('the service rejects %s itself too (token-id and batch paths reach it by name)', async (raw) => {
    const svc = new MetadataService(
      { indexerV2Endpoint: 'https://zigens.test/graphql', network: 'mainnet', fallbackToBlockchain: true, internalCacheEnabled: false, d1Enabled: false },
      { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
      { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
    );
    await expect(svc.getMetadata('mainnet', 'registry', decodeURIComponent(raw))).rejects.toBeInstanceOf(InvalidNameError);
  });
});

describe('a malformed name is answered before the edge cache', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(['/mainnet/registry/bad:.eth', '/mainnet/registry/bad:.eth/image', '/mainnet/registry/notaname', '/mainnet/registry/notaname/image'])(
    '%s: 400 without a cache lookup, even when the edge holds an entry for that URL',
    async (path) => {
      const match = vi.fn(async () => new Response('stale', { status: 200 }));
      vi.stubGlobal('caches', { default: { match, put: vi.fn(), delete: vi.fn() } });
      await expect400(path);
      expect(match).not.toHaveBeenCalled();
    },
  );
});
