import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BlockchainService } from '../src/services/blockchain';

// Mock environment
const mockEnv = {
  MAINNET_RPC_URL: 'https://ethereum.publicnode.com',
  NAMECHAIN_RPC_URL: 'https://namechain.rpc.url',
  MAINNET_FALLBACK_RPC_1: 'https://rpc.ankr.com/eth',
  MAINNET_FALLBACK_RPC_2: 'https://cloudflare-eth.com',
  NAMECHAIN_FALLBACK_RPC_1: 'https://namechain-fallback.rpc.url',
};

describe('BlockchainService', () => {
  let blockchainService: BlockchainService;

  beforeEach(() => {
    blockchainService = new BlockchainService(mockEnv);
  });

  it('should initialize clients for both networks', () => {
    expect(() => blockchainService.getClient('mainnet')).not.toThrow();
    expect(() => blockchainService.getClient('namechain')).not.toThrow();
  });

  it('should throw error for unsupported network', () => {
    expect(() => blockchainService.getClient('sepolia' as any)).toThrow('No client configured for network: sepolia');
  });

  it('should return network configuration', () => {
    const mainnetConfig = blockchainService.getNetworkConfig('mainnet');
    
    expect(mainnetConfig.name).toBe('mainnet');
    expect(mainnetConfig.rpcUrl).toBe(mockEnv.MAINNET_RPC_URL);
    expect(mainnetConfig.contracts.registry).toBeDefined();
    expect(mainnetConfig.contracts.registrar).toBeDefined();
    expect(mainnetConfig.contracts.nameWrapper).toBeDefined();
  });

  it('should get contract instances', () => {
    expect(() => blockchainService.getContract('mainnet', 'registry')).not.toThrow();
    expect(() => blockchainService.getContract('namechain', 'nameWrapper')).not.toThrow();
  });

  it('should have fallback clients configured from environment', () => {
    const mainnetClients = blockchainService.getAllClients('mainnet');
    const namechainClients = blockchainService.getAllClients('namechain');

    // Should have primary + fallbacks (2 fallbacks configured in mock)
    expect(mainnetClients.length).toBe(3); // Primary + 2 fallbacks
    expect(namechainClients.length).toBe(2); // Primary + 1 fallback
  });

  it('should use default fallbacks when no env vars provided', () => {
    const envWithoutFallbacks = {
      MAINNET_RPC_URL: 'https://ethereum.publicnode.com',
      NAMECHAIN_RPC_URL: 'https://namechain.rpc.url',
    };

    const serviceWithoutFallbacks = new BlockchainService(envWithoutFallbacks);
    const mainnetClients = serviceWithoutFallbacks.getAllClients('mainnet');

    // Should still have default fallbacks
    expect(mainnetClients.length).toBe(4); // Primary + 3 default fallbacks
  });

  // Skip actual network calls in unit tests
  it.skip('should execute operations with fallback', async () => {
    const result = await blockchainService.executeWithFallback('mainnet', async (client) => {
      return await client.getBlockNumber();
    });
    
    expect(result.result).toBeGreaterThan(0);
    expect(typeof result.usedFallback).toBe('boolean');
  });
});