import { describe, it, expect, vi } from 'vitest';
import { MetadataService } from '../src/services/metadata';

// Mock services
vi.mock('../src/services/ensnode');
vi.mock('../src/services/cache');
vi.mock('../src/services/blockchain');
vi.mock('../src/services/resolver');
vi.mock('../src/services/fallback');

// Mock KV namespace
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
} as unknown as KVNamespace;

// Mock blockchain environment
const mockBlockchainEnv = {
  MAINNET_RPC_URL: 'https://test-mainnet.rpc',
  NAMECHAIN_RPC_URL: 'https://test-namechain.rpc',
};

describe('Cross-Chain Sync', () => {
  const metadataService = new MetadataService(
    {
      ensnodeEndpoint: 'https://test-ensnode.graphql',
      fallbackToBlockchain: true,
      internalCacheEnabled: true,
      d1Enabled: false, // Disabled for testing
    },
    mockKV,
    mockBlockchainEnv
  );

  it('should compare metadata across chains', async () => {
    // Mock getMetadata to return different results for each network
    vi.spyOn(metadataService, 'getMetadata').mockImplementation(async (network) => {
      if (network === 'mainnet') {
        return {
          name: 'test.eth',
          tokenId: '0x123',
          version: 'v1',
          network: 'mainnet',
          description: 'test.eth, an ENS name.',
          image: 'https://metadata.ens.domains/test.eth/image',
          attributes: [
            { trait_type: 'Migration Status', value: 'Unmigrated' },
          ],
          external_url: 'https://app.ens.domains/name/test.eth',
        };
      } else {
        return {
          name: 'test.eth',
          tokenId: '0x123',
          version: 'v2',
          network: 'namechain',
          description: 'test.eth, an ENS name. This name has been migrated to ENS v2.',
          image: 'https://metadata.ens.domains/test.eth/image',
          attributes: [
            { trait_type: 'Migration Status', value: 'Migrated' },
          ],
          external_url: 'https://app.ens.domains/name/test.eth',
        };
      }
    });

    const result = await metadataService.getCrossChainSync('test.eth');

    expect(result.name).toBe('test.eth');
    expect(result.mainnet.exists).toBe(true);
    expect(result.namechain.exists).toBe(true);
    expect(result.consistent).toBe(false);
    expect(result.differences).toContain('version: mainnet=v1, namechain=v2');
    expect(result.differences).toContain('migration status: mainnet=Unmigrated, namechain=Migrated');
    expect(result.recommendation).toBe('inconsistent');

    // Restore original method
    vi.restoreAllMocks();
  });

  it('should handle domain only on mainnet', async () => {
    vi.spyOn(metadataService, 'getMetadata').mockImplementation(async (network) => {
      if (network === 'mainnet') {
        return {
          name: 'unmigrated.eth',
          tokenId: '0x456',
          version: 'v1',
          network: 'mainnet',
          description: 'unmigrated.eth, an ENS name.',
          image: 'https://metadata.ens.domains/unmigrated.eth/image',
          attributes: [
            { trait_type: 'Migration Status', value: 'Unmigrated' },
          ],
          external_url: 'https://app.ens.domains/name/unmigrated.eth',
        };
      } else {
        throw new Error('Domain not found on namechain');
      }
    });

    const result = await metadataService.getCrossChainSync('unmigrated.eth');

    expect(result.mainnet.exists).toBe(true);
    expect(result.namechain.exists).toBe(false);
    expect(result.recommendation).toBe('unmigrated');
    expect(result.differences).toContain('domain only exists on mainnet (not migrated)');

    vi.restoreAllMocks();
  });

  it('should handle domain only on namechain', async () => {
    vi.spyOn(metadataService, 'getMetadata').mockImplementation(async (network) => {
      if (network === 'namechain') {
        return {
          name: 'migrated.eth',
          tokenId: '0x789',
          version: 'v2',
          network: 'namechain',
          description: 'migrated.eth, an ENS name. This name has been migrated to ENS v2.',
          image: 'https://metadata.ens.domains/migrated.eth/image',
          attributes: [
            { trait_type: 'Migration Status', value: 'Migrated' },
          ],
          external_url: 'https://app.ens.domains/name/migrated.eth',
        };
      } else {
        throw new Error('Domain not found on mainnet');
      }
    });

    const result = await metadataService.getCrossChainSync('migrated.eth');

    expect(result.mainnet.exists).toBe(false);
    expect(result.namechain.exists).toBe(true);
    expect(result.recommendation).toBe('migrated');
    expect(result.differences).toContain('domain only exists on namechain (fully migrated)');

    vi.restoreAllMocks();
  });

  it('should handle domain not found on either chain', async () => {
    vi.spyOn(metadataService, 'getMetadata').mockImplementation(async () => {
      throw new Error('Domain not found');
    });

    const result = await metadataService.getCrossChainSync('nonexistent.eth');

    expect(result.mainnet.exists).toBe(false);
    expect(result.namechain.exists).toBe(false);
    expect(result.recommendation).toBe('error');
    expect(result.differences).toContain('domain not found on either chain');

    vi.restoreAllMocks();
  });

  it('should handle consistent migrated domain', async () => {
    vi.spyOn(metadataService, 'getMetadata').mockImplementation(async (network) => ({
      name: 'consistent.eth',
      tokenId: '0xabc',
      version: 'v2',
      network,
      description: 'consistent.eth, an ENS name. This name has been migrated to ENS v2.',
      image: 'https://metadata.ens.domains/consistent.eth/image',
      attributes: [
        { trait_type: 'Migration Status', value: 'Migrated' },
      ],
      external_url: 'https://app.ens.domains/name/consistent.eth',
    }));

    const result = await metadataService.getCrossChainSync('consistent.eth');

    expect(result.mainnet.exists).toBe(true);
    expect(result.namechain.exists).toBe(true);
    expect(result.consistent).toBe(true);
    expect(result.differences).toHaveLength(0);
    expect(result.recommendation).toBe('migrated');

    vi.restoreAllMocks();
  });

  it('should reject invalid ENS names', async () => {
    await expect(metadataService.getCrossChainSync('invalid-name'))
      .rejects.toThrow('Invalid ENS name format');
  });
});