import { describe, it, expect, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { InvalidTokenIdError } from '../src/services/errors';
import { CONTRACTS } from '../src/services/blockchain';

// Regression (WEB-1551): a token id that is not a number reached BigInt() in
// constructEthNameHash / tokenIdToHex and threw a SyntaxError, which the route
// reported as a 500 "Failed to resolve metadata". It is a client error.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

const REGISTRAR = CONTRACTS.mainnet.registrar;
const WRAPPER = CONTRACTS.mainnet.nameWrapper;

describe('non-numeric token ids are rejected with 400 before any lookup', () => {
  for (const [label, contract] of [['BaseRegistrar', REGISTRAR], ['NameWrapper', WRAPPER]] as const) {
    for (const suffix of ['', '/image', '/rasterize']) {
      it(`${label}${suffix || ' metadata'}: /mainnet/<contract>/abc`, async () => {
        const res = await req(`/mainnet/${contract}/abc${suffix}`);
        expect(res.status).toBe(400);
        expect(((await res.json()) as Record<string, unknown>).error).toBe('Invalid token id');
      });
    }
  }
});

describe('MetadataService.resolveTokenId validates the token id format', () => {
  const svc = new MetadataService(
    {
      indexerV2Endpoint: 'https://indexer.test/graphql',
      indexerV2ApiVersion: 'v1',
      network: 'mainnet',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );

  it.each(['abc', '12a', '-1', '1.5', '0x', '0xzz', ' 1', '', '2'.repeat(78), (2n ** 256n).toString(), `0x1${'0'.repeat(64)}`])(
    'rejects %j',
    async (tokenId) => {
      await expect(svc.resolveTokenId('mainnet', REGISTRAR, tokenId)).rejects.toBeInstanceOf(InvalidTokenIdError);
    },
  );

  it.each(['0', '123', '0001', '1'.repeat(78), (2n ** 256n - 1n).toString(), '0xdeadBEEF', '0XABC', `0x${'f'.repeat(64)}`])('accepts %j (fails later, not on format)', async (tokenId) => {
    const indexer = { getDomainByNamehash: vi.fn().mockResolvedValue({ domain: { name: 'fox.eth' } }) };
    (svc as unknown as { indexerV2: unknown }).indexerV2 = indexer;
    await expect(svc.resolveTokenId('mainnet', REGISTRAR, tokenId)).resolves.toEqual({ name: 'fox.eth', registryType: 'registry' });
  });
});

describe('a decimal token id at or above 2^256 is a 400, not a 500', () => {
  for (const suffix of ['', '/image', '/rasterize']) {
    it(`BaseRegistrar${suffix || ' metadata'}: 2^256`, async () => {
      const res = await req(`/mainnet/${REGISTRAR}/${2n ** 256n}${suffix}`);
      expect(res.status).toBe(400);
    });
  }
});

describe('every accepted spelling of a token id reaches the index in one canonical form', () => {
  const svc = new MetadataService(
    {
      indexerV2Endpoint: 'https://indexer.test/graphql',
      indexerV2ApiVersion: 'v1',
      network: 'mainnet',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
  const NODE = '0x0f4a10a4f46c288cea365fcf45cccf0e9d901b945b9829ccdb54c10dc3cb7a6f'; // any 32-byte id
  const spellings = [NODE, NODE.toUpperCase().replace('0X', '0x'), NODE.toUpperCase(), `0x${'0'.repeat(10)}${NODE.slice(2)}`, BigInt(NODE).toString()];

  it.each(spellings)('NameWrapper id %s', async (tokenId) => {
    const getDomainByNamehash = vi.fn().mockResolvedValue({ domain: { name: 'nick.eth' } });
    (svc as unknown as { indexerV2: unknown }).indexerV2 = { getDomainByNamehash };
    await expect(svc.resolveTokenId('mainnet', WRAPPER, tokenId)).resolves.toEqual({ name: 'nick.eth', registryType: 'namewrapper' });
    expect(getDomainByNamehash).toHaveBeenCalledWith(NODE);
  });
});
