import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataService } from '../src/services/metadata';
import { CONTRACTS } from '../src/services/blockchain';
import { constructEthNameHash, Version, tokenIdToHex } from '../src/utils/ens';
import { UpstreamError } from '../src/services/errors';

// Mock all heavy dependencies
vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    request: vi.fn(),
  })),
}));

vi.mock('../src/services/blockchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/blockchain')>();
  return {
    ...actual,
    BlockchainService: vi.fn().mockImplementation(() => ({
      getOwner: vi.fn(),
      getResolver: vi.fn(),
      healthCheck: vi.fn(),
      // v2 wiring: not configured in this suite (mainnet-style placeholders)
      isV2Configured: vi.fn().mockReturnValue(false),
      getV2Registries: vi.fn().mockResolvedValue(null),
      getV2Registration: vi.fn().mockResolvedValue(null),
      isUnmigratedName: vi.fn().mockResolvedValue(true),
    })),
  };
});

vi.mock('../src/services/resolver', () => ({
  ResolverService: vi.fn().mockImplementation(() => ({
    resolveName: vi.fn(),
    determineMigrationStatus: vi.fn().mockResolvedValue('unmigrated'),
  })),
}));

vi.mock('../src/services/d1', () => ({
  D1Service: vi.fn().mockImplementation(() => ({
    getDomainData: vi.fn().mockResolvedValue(null),
    storeMigrationStatus: vi.fn(),
    updateSyncStatus: vi.fn(),
  })),
}));

vi.mock('../src/services/sync', () => ({
  SyncService: vi.fn().mockImplementation(() => ({})),
  DEFAULT_SYNC_CONFIG: {},
}));

// Mock the ensnode service to control getDomainByNamehash / getDomainByTokenId
const mockGetDomainByNamehash = vi.fn();
const mockGetDomainByTokenId = vi.fn();
const mockIsRegistry = vi.fn();
vi.mock('../src/services/indexer', () => ({
  IndexerService: vi.fn().mockImplementation(() => ({
    getDomain: vi.fn(),
    getDomains: vi.fn(),
    getDomainByNamehash: mockGetDomainByNamehash,
    getDomainByTokenId: mockGetDomainByTokenId,
    isRegistry: mockIsRegistry,
    getMigrationStatus: vi.fn(),
    getHierarchy: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ primary: true, latency: {} }),
  })),
}));

vi.mock('../src/services/cache', () => ({
  CacheService: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    delete: vi.fn(),
    deleteByPrefix: vi.fn(),
  })),
  CacheKeys: {
    domain: (name: string) => `domain:${name}`,
    migrationStatus: (name: string) => `migration:${name}`,
    hierarchy: (name: string) => `hierarchy:${name}`,
  },
  CacheTTL: { ensnode: 300, error: 30 },
}));

const mockKV = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
};

const mockD1 = {
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
  }),
  exec: vi.fn(),
  batch: vi.fn(),
  dump: vi.fn(),
};

describe('MetadataService.resolveTokenId', () => {
  let metadataService: MetadataService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: tokenId-filter lookup misses (matches a zigens deploy without the
    // filter); individual tests override for filter-hit scenarios.
    mockGetDomainByTokenId.mockResolvedValue({ domain: null, usedFallback: false });
    mockIsRegistry.mockResolvedValue(false);

    metadataService = new MetadataService(
      {
        indexerV2Endpoint: 'https://test-ensnode.example.com/subgraph',
        fallbackToBlockchain: false,
        internalCacheEnabled: false,
        d1Enabled: false,
      },
      mockKV as unknown as KVNamespace,
      {
        MAINNET_RPC_URL: 'https://mainnet.test.rpc',
        SEPOLIA_RPC_URL: 'https://sepolia.test.rpc',
      },
      mockD1 as unknown as D1Database,
    );
  });

  describe('BaseRegistrar (registry) tokenId resolution', () => {
    const registrarAddress = CONTRACTS.mainnet.registrar;

    it('should resolve a BaseRegistrar tokenId to an ENS name', async () => {
      // tokenId for "nick" label (decimal representation of labelhash)
      const tokenId = '79233663829379634837589865448569342784712482819484549289560981379859480642508';

      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'nick.eth', labelName: 'nick' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('mainnet', registrarAddress, tokenId);

      expect(result.name).toBe('nick.eth');
      expect(result.registryType).toBe('registry');

      // Verify the namehash was computed correctly
      const expectedNamehash = constructEthNameHash(tokenId, Version.v1);
      expect(mockGetDomainByNamehash).toHaveBeenCalledWith(expectedNamehash);
    });

    it('should be case-insensitive for contract address', async () => {
      const tokenId = '12345';

      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'test.eth' },
        usedFallback: false,
      });

      // Use uppercase address
      await metadataService.resolveTokenId('mainnet', registrarAddress.toUpperCase(), tokenId);
      expect(mockGetDomainByNamehash).toHaveBeenCalled();
    });

    it('should throw when domain not found for tokenId', async () => {
      mockGetDomainByNamehash.mockResolvedValue({
        domain: null,
        usedFallback: false,
      });

      await expect(
        metadataService.resolveTokenId('mainnet', registrarAddress, '999999')
      ).rejects.toThrow('No domain found for tokenId 999999');
    });
  });

  describe('NameWrapper tokenId resolution', () => {
    const nameWrapperAddress = CONTRACTS.mainnet.nameWrapper;

    it('should resolve a NameWrapper tokenId (namehash) to an ENS name', async () => {
      // NameWrapper tokenId is a namehash (as decimal)
      const namehashDecimal = '28830309785498705498605967065639339498816498484392297776506587544614029665578';
      const expectedHex = tokenIdToHex(namehashDecimal);

      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'vitalik.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('mainnet', nameWrapperAddress, namehashDecimal);

      expect(result.name).toBe('vitalik.eth');
      expect(result.registryType).toBe('namewrapper');
      expect(mockGetDomainByNamehash).toHaveBeenCalledWith(expectedHex);
    });

    it('should handle hex tokenId for NameWrapper', async () => {
      const namehashHex = '0x3fce7d1364a893e213bc4571b6eb3ea1ba863783bfaf328185af16547c5cebea';

      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'wrapped.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('mainnet', nameWrapperAddress, namehashHex);

      expect(result.name).toBe('wrapped.eth');
      expect(result.registryType).toBe('namewrapper');
    });
  });

  describe('Unknown contract address', () => {
    it('should throw for unrecognized contract address', async () => {
      const unknownAddress = '0x0000000000000000000000000000000000000001';

      await expect(
        metadataService.resolveTokenId('mainnet', unknownAddress, '12345')
      ).rejects.toThrow('Unknown contract address: 0x0000000000000000000000000000000000000001');
      // No v2 on mainnet: no registry lookup either.
      expect(mockIsRegistry).not.toHaveBeenCalled();
    });
  });

  describe('v2 ETHRegistry (sepolia)', () => {
    // The configured last-known live registry (config/networks.ts sepolia.v2.ethRegistry)
    const V2_ETH_REGISTRY = '0x657ea849311d3d5823348dded7c2aaafb3ede09e';

    it('recognizes the v2 ETHRegistry address and resolves a namehash-form tokenId', async () => {
      // Some consumers pass namehash-form ids; zigens domain(id:) resolves those.
      const hash = '0x54cb177469278d1e8e843f0d60633cb4b038af8c4c5be8993161e87ca4a50b4c'; // namehash(fox.eth)
      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'fox.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, hash);

      expect(result.name).toBe('fox.eth');
      expect(result.registryType).toBe('registry');
      expect(mockGetDomainByNamehash).toHaveBeenCalledWith(hash);
    });

    it('resolves a native versioned tokenId via the indexer tokenId filter', async () => {
      // fox.eth labelhash with low 32 bits = version 1
      const versionedTokenId = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001';
      mockGetDomainByTokenId.mockResolvedValue({
        domain: { name: 'fox.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, versionedTokenId);

      expect(result.name).toBe('fox.eth');
      expect(result.registryType).toBe('registry');
      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(versionedTokenId, V2_ETH_REGISTRY);
      // The filter hit short-circuits — no namehash-form fallback query.
      expect(mockGetDomainByNamehash).not.toHaveBeenCalled();
    });

    it('converts a decimal-form (marketplace) tokenId to hex before the filter lookup', async () => {
      const versionedHex = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001';
      const decimal = BigInt(versionedHex).toString(10);
      mockGetDomainByTokenId.mockResolvedValue({
        domain: { name: 'fox.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, decimal);

      expect(result.name).toBe('fox.eth');
      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(versionedHex, V2_ETH_REGISTRY);
    });

    it.each([
      ['0X5A95EE1DC2A184B02AF4E3B4DEAE1B95AACBF29F651487D77E4A9B3C00000001', '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001'],
      ['0x1', `0x${'0'.repeat(63)}1`],
    ])('looks %s up in canonical form (lowercase, 64 hex digits) in both lookups', async (written, canonical) => {
      mockGetDomainByNamehash.mockResolvedValue({ domain: { name: 'fox.eth' }, usedFallback: false });

      await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, written);

      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(canonical, V2_ETH_REGISTRY);
      expect(mockGetDomainByNamehash).toHaveBeenCalledWith(canonical);
    });

    it('falls through to the namehash path when the filter lookup misses (filter not deployed)', async () => {
      const hash = '0x54cb177469278d1e8e843f0d60633cb4b038af8c4c5be8993161e87ca4a50b4c'; // namehash(fox.eth)
      mockGetDomainByTokenId.mockResolvedValue({ domain: null, usedFallback: false });
      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'fox.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, hash);

      expect(result.name).toBe('fox.eth');
      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(hash, V2_ETH_REGISTRY);
      expect(mockGetDomainByNamehash).toHaveBeenCalledWith(hash);
    });

    it('surfaces an outage (UpstreamError, not 404) when the filter and namehash lookups are both down', async () => {
      const versionedTokenId = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001';
      mockGetDomainByTokenId.mockRejectedValue(new UpstreamError('indexer down'));
      mockGetDomainByNamehash.mockRejectedValue(new UpstreamError('indexer down'));

      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, versionedTokenId)
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it('scopes the lookup to the registry in the URL, lowercased', async () => {
      const versionedTokenId = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001';
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'fox.eth' }, usedFallback: false });

      await metadataService.resolveTokenId('sepolia', '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E', versionedTokenId);

      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(versionedTokenId, V2_ETH_REGISTRY);
    });

    it('does not serve a subname for a namehash-form id: an ETHRegistry token is a name directly under eth', async () => {
      const hash = '0x' + 'ab'.repeat(32); // namehash of a subname
      mockGetDomainByNamehash.mockResolvedValue({ domain: { name: 'jamon.sepolia.is-a-capybara.eth' }, usedFallback: false });

      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, hash)
      ).rejects.toThrow('No domain found for tokenId');
    });

    it('surfaces an outage of the token lookup when the namehash path answers with a miss (503, not 404)', async () => {
      // domain(id:) resolves only namehashes, so its miss says nothing about a native id.
      const versionedTokenId = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001';
      mockGetDomainByTokenId.mockRejectedValue(new UpstreamError('indexer down'));
      mockGetDomainByNamehash.mockResolvedValue({ domain: null, usedFallback: false });

      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, versionedTokenId)
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    describe('as deployed on sepolia: v2 configured, with the v1 subgraph', () => {
      let svc: MetadataService;

      beforeEach(() => {
        svc = new MetadataService(
          {
            indexerV2Endpoint: 'https://test-ensnode.example.com/subgraph',
            indexerV1Endpoint: 'https://v1.test/subgraph',
            fallbackToBlockchain: false,
            internalCacheEnabled: false,
            d1Enabled: false,
          },
          mockKV as unknown as KVNamespace,
          { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
          mockD1 as unknown as D1Database,
        );
        (svc as unknown as { blockchain: { isV2Configured: ReturnType<typeof vi.fn> } })
          .blockchain.isV2Configured.mockReturnValue(true);
      });

      it('takes the ETHRegistry path, not the registry lookup: a namehash-form id still resolves', async () => {
        const hash = '0x54cb177469278d1e8e843f0d60633cb4b038af8c4c5be8993161e87ca4a50b4c'; // namehash(fox.eth)
        mockGetDomainByNamehash.mockResolvedValue({ domain: { name: 'fox.eth' }, usedFallback: false });

        await expect(svc.resolveTokenId('sepolia', V2_ETH_REGISTRY, hash))
          .resolves.toEqual({ name: 'fox.eth', registryType: 'registry' });
        expect(mockIsRegistry).not.toHaveBeenCalled();
      });

      it('does not serve a subname the v1 subgraph names for a namehash-form id', async () => {
        const hash = '0x' + 'ab'.repeat(32); // namehash of a subname
        mockGetDomainByNamehash
          .mockResolvedValueOnce({ domain: null, usedFallback: false }) // v2
          .mockResolvedValueOnce({ domain: { name: 'sub.foo.eth' }, usedFallback: false }); // v1

        await expect(svc.resolveTokenId('sepolia', V2_ETH_REGISTRY, hash)).rejects.toThrow('No domain found for tokenId');
        expect(mockGetDomainByNamehash).toHaveBeenCalledTimes(2);
      });

      it('rethrows the v2 outage when only the v1 subgraph answers, with a subname', async () => {
        const hash = '0x' + 'ab'.repeat(32);
        mockGetDomainByNamehash
          .mockRejectedValueOnce(new UpstreamError('indexer down')) // v2
          .mockResolvedValueOnce({ domain: { name: 'sub.foo.eth' }, usedFallback: false }); // v1

        await expect(svc.resolveTokenId('sepolia', V2_ETH_REGISTRY, hash)).rejects.toBeInstanceOf(UpstreamError);
      });
    });

    it('404s (NotFound, not "unknown contract") for a native v2 tokenId that no indexer can reverse', async () => {
      // The ERC1155 tokenId is the labelhash with its low 32 bits replaced by the
      // token version — the real labelhash is unrecoverable, so the indexer misses.
      const versionedTokenId = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000000';
      mockGetDomainByNamehash.mockResolvedValue({ domain: null, usedFallback: false });

      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, versionedTokenId)
      ).rejects.toThrow('No domain found for tokenId');
    });
  });

  describe('any other v2 registry (sepolia: root, user and wrapper registries)', () => {
    const SUBREGISTRY = '0x6f076422511cf206088e710de61abbe5fae0e516'; // sepolia.is-a-capybara.eth's
    const TOKEN_ID = '0xb76e770157f06a5280fb1ece7975ce63928d70d2925e118ee603df4800000000'; // jamon

    beforeEach(() => {
      // v2 is deployed on this network.
      (metadataService as unknown as { blockchain: { isV2Configured: ReturnType<typeof vi.fn> } })
        .blockchain.isV2Configured.mockReturnValue(true);
      mockIsRegistry.mockResolvedValue(true);
    });

    it('names a token of a registry the indexer knows, scoped to that registry', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'jamon.sepolia.is-a-capybara.eth' }, usedFallback: false });

      const result = await metadataService.resolveTokenId(
        'sepolia',
        '0x6F076422511cF206088e710DE61ABBE5fAE0E516',
        BigInt(TOKEN_ID).toString(),
      );

      expect(result).toEqual({ name: 'jamon.sepolia.is-a-capybara.eth', registryType: 'registry' });
      expect(mockIsRegistry).toHaveBeenCalledWith(SUBREGISTRY);
      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(TOKEN_ID, SUBREGISTRY);
      // No unscoped namehash lookup: a random id must not name an unrelated domain.
      expect(mockGetDomainByNamehash).not.toHaveBeenCalled();
    });

    it('404s an address the indexer knows no registry at, without a token lookup', async () => {
      mockIsRegistry.mockResolvedValue(false);

      await expect(
        metadataService.resolveTokenId('sepolia', SUBREGISTRY, TOKEN_ID)
      ).rejects.toThrow(`Unknown contract address: ${SUBREGISTRY}`);
      expect(mockGetDomainByTokenId).not.toHaveBeenCalled();
    });

    it('404s a token the registry does not hold (or holds unreachable)', async () => {
      await expect(
        metadataService.resolveTokenId('sepolia', SUBREGISTRY, TOKEN_ID)
      ).rejects.toThrow('No domain found for tokenId');
      expect(mockGetDomainByNamehash).not.toHaveBeenCalled();
    });

    it('404s a root registry token: a top-level name is not served', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'eth' }, usedFallback: false });

      await expect(
        metadataService.resolveTokenId('sepolia', SUBREGISTRY, TOKEN_ID)
      ).rejects.toThrow('Top-level name eth is not served');
    });

    it.each([
      ['the registry lookup', () => mockIsRegistry.mockRejectedValue(new UpstreamError('indexer down'))],
      ['the token lookup', () => mockGetDomainByTokenId.mockRejectedValue(new UpstreamError('indexer down'))],
    ])('surfaces an outage in %s (503, not a cacheable 404)', async (_where, fail) => {
      fail();
      await expect(
        metadataService.resolveTokenId('sepolia', SUBREGISTRY, TOKEN_ID)
      ).rejects.toBeInstanceOf(UpstreamError);
    });
  });

  describe('Sepolia network', () => {
    it('should use sepolia contract addresses', async () => {
      const sepoliaRegistrar = CONTRACTS.sepolia.registrar;
      const tokenId = '12345';

      mockGetDomainByNamehash.mockResolvedValue({
        domain: { name: 'test.eth' },
        usedFallback: false,
      });

      const result = await metadataService.resolveTokenId('sepolia', sepoliaRegistrar, tokenId);

      expect(result.name).toBe('test.eth');
      expect(result.registryType).toBe('registry');
    });

    it('should reject unknown contract address on sepolia', async () => {
      const unknownAddress = '0x0000000000000000000000000000000000000001';

      await expect(
        metadataService.resolveTokenId('sepolia', unknownAddress, '12345')
      ).rejects.toThrow('Unknown contract address');
    });
  });
});
