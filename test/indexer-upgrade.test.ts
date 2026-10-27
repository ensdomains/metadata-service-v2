import { describe, it, expect } from 'vitest';
import { resolveIndexerConfig, type IndexerEnv } from '../src/config/networks';

// resolveIndexerConfig is the single source for indexer wiring (service
// construction AND webhook v2-event targeting). These tests pin the env-gated
// mainnet v2 upgrade: unset ⇒ byte-identical to the static config; set ⇒ the
// two-tier v2 shape (v2 primary, subgraph demoted to v1 secondary).

const BASE: IndexerEnv = {
  ENSNODE_MAINNET_V1_URL: 'https://subgraph.mainnet.test',
  ENSNODE_SEPOLIA_V2_URL: 'https://zigens.test',
  ENSNODE_SEPOLIA_V1_URL: 'https://subgraph.sepolia.test',
};

describe('resolveIndexerConfig — env-gated mainnet v2 upgrade', () => {
  it('mainnet without ENSNODE_MAINNET_V2_URL keeps the v1 subgraph primary with no secondary', () => {
    expect(resolveIndexerConfig('mainnet', BASE)).toEqual({
      indexerV2Endpoint: 'https://subgraph.mainnet.test',
      indexerV2ApiVersion: 'v1',
      indexerV1Endpoint: undefined,
    });
  });

  it('mainnet with ENSNODE_MAINNET_V2_URL flips to v2 primary and demotes the subgraph to the v1 secondary', () => {
    expect(
      resolveIndexerConfig('mainnet', { ...BASE, ENSNODE_MAINNET_V2_URL: 'https://zigens.mainnet.test' }),
    ).toEqual({
      indexerV2Endpoint: 'https://zigens.mainnet.test',
      indexerV2ApiVersion: 'v2',
      indexerV1Endpoint: 'https://subgraph.mainnet.test',
    });
  });

  it('a blank/whitespace ENSNODE_MAINNET_V2_URL counts as unset (no half-configured flip)', () => {
    for (const blank of ['', '   ']) {
      expect(resolveIndexerConfig('mainnet', { ...BASE, ENSNODE_MAINNET_V2_URL: blank }).indexerV2ApiVersion).toBe('v1');
    }
  });

  it('sepolia is unaffected by the mainnet upgrade var', () => {
    const expected = {
      indexerV2Endpoint: 'https://zigens.test',
      indexerV2ApiVersion: 'v2',
      indexerV1Endpoint: 'https://subgraph.sepolia.test',
    };
    expect(resolveIndexerConfig('sepolia', BASE)).toEqual(expected);
    expect(
      resolveIndexerConfig('sepolia', { ...BASE, ENSNODE_MAINNET_V2_URL: 'https://zigens.mainnet.test' }),
    ).toEqual(expected);
  });
});
