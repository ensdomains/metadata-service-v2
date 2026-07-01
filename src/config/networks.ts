// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for supported networks.
//
// To add a new network: add an entry to NETWORKS below, add its env-binding keys
// to the Env interface (src/index.ts) + BlockchainEnvironment (services/metadata.ts)
// + the *EnvKey unions in this file, and that's it — `NetworkName`,
// `SUPPORTED_NETWORKS`, RPC/indexer wiring, viem clients, and contract lookups all
// derive from here. Nothing else hardcodes the network list.
// ─────────────────────────────────────────────────────────────────────────────
import type { Chain } from 'viem';
import { mainnet, sepolia } from 'viem/chains';

// Env-binding key names, kept as literal unions so `env[key]` stays type-safe.
type RpcUrlEnvKey = 'MAINNET_RPC_URL' | 'SEPOLIA_RPC_URL';
type IndexerV2UrlEnvKey = 'ENSNODE_MAINNET_URL' | 'ENSNODE_SEPOLIA_V2_URL';
type IndexerV1UrlEnvKey = 'ENSNODE_SEPOLIA_V1_URL';
type FallbackRpcEnvKey =
  | 'MAINNET_FALLBACK_RPC_1'
  | 'MAINNET_FALLBACK_RPC_2'
  | 'MAINNET_FALLBACK_RPC_3'
  | 'SEPOLIA_FALLBACK_RPC_1'
  | 'SEPOLIA_FALLBACK_RPC_2';

// ENS v1 (legacy) contracts — for unmigrated names.
export interface V1Contracts {
  registry: string;
  registrar: string;
  nameWrapper: string;
  resolver: string;
}

// ENS v2 contracts. Mainnet values are placeholder strings until v2 deploys there
// (the `!startsWith('0x')` guard in blockchain.ts relies on them not being addresses).
export interface V2Contracts {
  rootRegistry: string;
  ethRegistry: string;
  migrationContract: string;
  resolver: string;
  /**
   * UniversalResolverV2 (ENSv2). Used for on-chain resolver lookup via
   * `findResolver` (and resolve/reverse). Placeholder until the deployed address
   * is known — guarded by the `!startsWith('0x')` pattern, so the on-chain v2
   * resolution path falls back to manual registry traversal until it's set.
   */
  universalResolver: string;
  legacyRegistry: string;
  legacyNameWrapper: string;
  legacyResolver: string;
}

export interface NetworkDefinition {
  chain: Chain;
  /** Primary indexer query dialect: mainnet → ENSNode subgraph (v1); sepolia → zigens (v2). */
  indexerV2ApiVersion: 'v1' | 'v2';
  rpcUrlEnvKey: RpcUrlEnvKey;
  indexerV2UrlEnvKey: IndexerV2UrlEnvKey;
  /**
   * Optional secondary v1 indexer (ENSNode subgraph) for networks whose primary
   * indexer is v2-only (zigens has no v1 data). Resolution order is v2 → v1 →
   * on-chain, so v1-only names on a v2 network still resolve via the indexer.
   */
  indexerV1UrlEnvKey?: IndexerV1UrlEnvKey;
  fallbackRpcEnvKeys: readonly FallbackRpcEnvKey[];
  /** Used only when no fallback env vars are set. */
  defaultFallbackRpcs: readonly string[];
  contracts: V1Contracts;
  v2: V2Contracts;
}

export const NETWORKS = {
  mainnet: {
    chain: mainnet,
    indexerV2ApiVersion: 'v1',
    rpcUrlEnvKey: 'MAINNET_RPC_URL',
    indexerV2UrlEnvKey: 'ENSNODE_MAINNET_URL',
    indexerV1UrlEnvKey: undefined, // mainnet's primary indexer is already v1 (no v2 deployed)
    fallbackRpcEnvKeys: ['MAINNET_FALLBACK_RPC_1', 'MAINNET_FALLBACK_RPC_2', 'MAINNET_FALLBACK_RPC_3'],
    defaultFallbackRpcs: ['https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
    // ENS v1 — aligned to zigens src/contracts.zig mainnetAddresses.
    contracts: {
      registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',     // ens_registry
      registrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',    // base_registrar
      nameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',  // name_wrapper
      // public_resolver — was the 2021 PublicResolver (0x231b0Ee1…); zigens tracks
      // the current PublicResolver. Only a last-resort fallback default.
      resolver: '0xF29100983E058B709F3D539b0c765937B804AC15',
    },
    // ENS v2 — not yet deployed on mainnet; placeholder strings (not addresses).
    v2: {
      rootRegistry: 'ROOT_REGISTRY_ADDRESS',
      ethRegistry: 'ETH_REGISTRY_ADDRESS',
      migrationContract: 'MIGRATION_CONTROLLER_ADDRESS',
      resolver: 'ENSV2_RESOLVER_ADDRESS',
      universalResolver: 'UNIVERSAL_RESOLVER_V2_ADDRESS',
      legacyRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
      legacyNameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
      legacyResolver: '0xF29100983E058B709F3D539b0c765937B804AC15',
    },
  },
  sepolia: {
    chain: sepolia,
    indexerV2ApiVersion: 'v2',
    rpcUrlEnvKey: 'SEPOLIA_RPC_URL',
    indexerV2UrlEnvKey: 'ENSNODE_SEPOLIA_V2_URL',          // v2: zigens (graphql.ens.dev)
    indexerV1UrlEnvKey: 'ENSNODE_SEPOLIA_V1_URL',     // v1: ENSNode sepolia subgraph
    fallbackRpcEnvKeys: ['SEPOLIA_FALLBACK_RPC_1', 'SEPOLIA_FALLBACK_RPC_2'],
    defaultFallbackRpcs: [],
    // ENS v1 — aligned to zigens src/contracts.zig sepoliaAddresses (the same
    // deployment graphql.ens.dev indexes, so on-chain reads and GraphQL agree).
    contracts: {
      registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',     // ens_registry
      registrar: '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85',    // base_registrar
      nameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',  // name_wrapper
      resolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',     // public_resolver
    },
    // ENS v2 (Sepolia) — June 2026 deployment (architecture/ens_v2_june_deplyoyment.txt).
    v2: {
      rootRegistry: '0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c',  // RootRegistry
      ethRegistry: '0x67b728a792e789a8978b30cf1b3b641f19354b43',   // ETHRegistry
      // Migration is handled by separate controllers (see src/utils/migration.ts).
      // June deployment: MigrationHelper 0xd54a53c1567b26f9653c8565dccc39bceb6ab327 (V1 side),
      // LockedMigrationController 0x681802eff57b83edce99d688c023ab1284495176,
      // UnlockedMigrationController 0xd021a69db7f9e276a59cbbccf06e7f1e5434215c (V2 side).
      migrationContract: '0x681802eff57b83edce99d688c023ab1284495176', // LockedMigrationController
      // v2 resolvers are per-owner (no single canonical); last-resort fallback only.
      resolver: '0xd25f66dd4ff61486c2c5c1e6201a23576698d3df', // PublicResolverV2
      // UniversalResolverV2 (sepolia), June 2026 deployment. Used by
      // BlockchainService.getResolverV2 (findResolver) and AvatarService
      // (avatar/header records). Proxy alternatives from the same deployment:
      // ManagedUniversalResolverProxy 0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1,
      // UpgradableUniversalResolverProxy 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe.
      universalResolver: '0x85edf8b6b7d4211e2b07aa687506b746357b92cf',
      legacyRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
      legacyNameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
      legacyResolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
    },
  },
} satisfies Record<string, NetworkDefinition>;

export type NetworkName = keyof typeof NETWORKS;

export const SUPPORTED_NETWORKS = Object.keys(NETWORKS) as NetworkName[];

/** Runtime guard / narrowing for untrusted input (path params, request bodies). */
export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === 'string' && value in NETWORKS;
}
