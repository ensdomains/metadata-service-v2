import { describe, it, expect, vi } from 'vitest';
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
