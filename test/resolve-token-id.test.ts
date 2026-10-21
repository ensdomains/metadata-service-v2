import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataService } from '../src/services/metadata';
import { CONTRACTS } from '../src/services/blockchain';
import { tokenIdToHex } from '../src/utils/ens';
import { UpstreamError } from '../src/services/errors';

// Mock all heavy dependencies
const mockGetWrappedName = vi.fn();

vi.mock('../src/services/blockchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/blockchain')>();
  return {
    ...actual,
    BlockchainService: vi.fn().mockImplementation(() => ({
      getOwner: vi.fn(),
      getResolver: vi.fn(),
      getWrappedName: mockGetWrappedName,
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

// Mock the indexer service to control the token lookups
const mockGetEthDomainByLabelhash = vi.fn();
const mockGetDomainByTokenId = vi.fn();
const mockIsRegistry = vi.fn();
vi.mock('../src/services/indexer', () => ({
  IndexerService: vi.fn().mockImplementation(() => ({
    getDomain: vi.fn(),
    getDomains: vi.fn(),
    getEthDomainByLabelhash: mockGetEthDomainByLabelhash,
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
    mockGetDomainByTokenId.mockResolvedValue({ domain: null });
    mockGetEthDomainByLabelhash.mockResolvedValue({ domain: null });
    mockGetWrappedName.mockResolvedValue(null);
    mockIsRegistry.mockResolvedValue(false);

    metadataService = new MetadataService(
      {
        indexerV2Endpoint: 'https://api.bigname.test',
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

    it('reads the .eth name by the labelhash the token id is', async () => {
      // tokenId for "nick" label (decimal representation of labelhash)
      const tokenId = '79233663829379634837589865448569342784712482819484549289560981379859480642508';
      mockGetEthDomainByLabelhash.mockResolvedValue({ domain: { name: 'nick.eth', labelName: 'nick' } });

      const result = await metadataService.resolveTokenId('mainnet', registrarAddress, tokenId);

      expect(result).toEqual({ name: 'nick.eth', registryType: 'registry' });
      expect(mockGetEthDomainByLabelhash).toHaveBeenCalledWith(tokenIdToHex(tokenId));
    });

    it('should be case-insensitive for contract address', async () => {
      mockGetEthDomainByLabelhash.mockResolvedValue({ domain: { name: 'test.eth' } });

      await metadataService.resolveTokenId('mainnet', registrarAddress.toUpperCase(), '12345');
      expect(mockGetEthDomainByLabelhash).toHaveBeenCalled();
    });

    it('should throw when domain not found for tokenId', async () => {
      await expect(
        metadataService.resolveTokenId('mainnet', registrarAddress, '999999')
      ).rejects.toThrow('No domain found for tokenId 999999');
    });

    it('surfaces an indexer outage (503, not a cacheable 404)', async () => {
      mockGetEthDomainByLabelhash.mockRejectedValue(new UpstreamError('indexer down'));
      await expect(
        metadataService.resolveTokenId('mainnet', registrarAddress, '12345')
      ).rejects.toBeInstanceOf(UpstreamError);
    });
  });

  describe('NameWrapper tokenId resolution', () => {
    const nameWrapperAddress = CONTRACTS.mainnet.nameWrapper;

    it('reads the name the NameWrapper keeps for the node the token id is', async () => {
      const namehashDecimal = '28830309785498705498605967065639339498816498484392297776506587544614029665578';
      mockGetWrappedName.mockResolvedValue('vitalik.eth');

      const result = await metadataService.resolveTokenId('mainnet', nameWrapperAddress, namehashDecimal);

      expect(result).toEqual({ name: 'vitalik.eth', registryType: 'namewrapper' });
      expect(mockGetWrappedName).toHaveBeenCalledWith('mainnet', tokenIdToHex(namehashDecimal));
      expect(mockGetEthDomainByLabelhash).not.toHaveBeenCalled();
    });

    it('should handle hex tokenId for NameWrapper', async () => {
      const namehashHex = '0x3fce7d1364a893e213bc4571b6eb3ea1ba863783bfaf328185af16547c5cebea';
      mockGetWrappedName.mockResolvedValue('wrapped.eth');

      const result = await metadataService.resolveTokenId('mainnet', nameWrapperAddress, namehashHex);

      expect(result).toEqual({ name: 'wrapped.eth', registryType: 'namewrapper' });
    });

    it('404s a node the NameWrapper never wrapped', async () => {
      await expect(
        metadataService.resolveTokenId('mainnet', nameWrapperAddress, '12345')
      ).rejects.toThrow('No domain found for tokenId 12345');
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
    // fox.eth labelhash with low 32 bits = version 1
    const VERSIONED = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001';

    it('resolves a native versioned tokenId via the indexer, scoped to the registry', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'fox.eth' } });

      const result = await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, VERSIONED);

      expect(result).toEqual({ name: 'fox.eth', registryType: 'registry' });
      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(VERSIONED, V2_ETH_REGISTRY);
    });

    it('converts a decimal-form (marketplace) tokenId to hex before the lookup', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'fox.eth' } });

      await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, BigInt(VERSIONED).toString(10));

      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(VERSIONED, V2_ETH_REGISTRY);
    });

    it.each([
      [VERSIONED.toUpperCase(), VERSIONED],
      ['0x1', `0x${'0'.repeat(63)}1`],
    ])('looks %s up in canonical form (lowercase, 64 hex digits)', async (written, canonical) => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'fox.eth' } });

      await metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, written);

      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(canonical, V2_ETH_REGISTRY);
    });

    it('scopes the lookup to the registry, lowercased', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'fox.eth' } });

      await metadataService.resolveTokenId('sepolia', '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E', VERSIONED);

      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(VERSIONED, V2_ETH_REGISTRY);
    });

    it('404s a token the indexer cannot name', async () => {
      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, VERSIONED)
      ).rejects.toThrow('No domain found for tokenId');
    });

    it('does not serve a subname: an ETHRegistry token is a name directly under eth', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'jamon.sepolia.is-a-capybara.eth' } });

      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, VERSIONED)
      ).rejects.toThrow('No domain found for tokenId');
    });

    it('surfaces an outage (UpstreamError, not 404)', async () => {
      mockGetDomainByTokenId.mockRejectedValue(new UpstreamError('indexer down'));

      await expect(
        metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, VERSIONED)
      ).rejects.toBeInstanceOf(UpstreamError);
    });

    it('takes the ETHRegistry path, not the registry lookup, where v2 is configured', async () => {
      (metadataService as unknown as { blockchain: { isV2Configured: ReturnType<typeof vi.fn> } })
        .blockchain.isV2Configured.mockReturnValue(true);
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'fox.eth' } });

      await expect(metadataService.resolveTokenId('sepolia', V2_ETH_REGISTRY, VERSIONED))
        .resolves.toEqual({ name: 'fox.eth', registryType: 'registry' });
      expect(mockIsRegistry).not.toHaveBeenCalled();
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
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'jamon.sepolia.is-a-capybara.eth' } });

      const result = await metadataService.resolveTokenId(
        'sepolia',
        '0x6F076422511cF206088e710DE61ABBE5fAE0E516',
        BigInt(TOKEN_ID).toString(),
      );

      expect(result).toEqual({ name: 'jamon.sepolia.is-a-capybara.eth', registryType: 'registry' });
      expect(mockIsRegistry).toHaveBeenCalledWith(SUBREGISTRY);
      expect(mockGetDomainByTokenId).toHaveBeenCalledWith(TOKEN_ID, SUBREGISTRY);
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
    });

    it('404s a root registry token: a top-level name is not served', async () => {
      mockGetDomainByTokenId.mockResolvedValue({ domain: { name: 'eth' } });

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
      mockGetEthDomainByLabelhash.mockResolvedValue({ domain: { name: 'test.eth' } });

      const result = await metadataService.resolveTokenId('sepolia', CONTRACTS.sepolia.registrar, '12345');

      expect(result).toEqual({ name: 'test.eth', registryType: 'registry' });
    });

    it('should reject unknown contract address on sepolia', async () => {
      const unknownAddress = '0x0000000000000000000000000000000000000001';

      await expect(
        metadataService.resolveTokenId('sepolia', unknownAddress, '12345')
      ).rejects.toThrow('Unknown contract address');
    });
  });
});
