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
type EnsnodeUrlEnvKey = 'ENSNODE_MAINNET_URL' | 'ENSNODE_SEPOLIA_V2_URL';
type EnsnodeV1UrlEnvKey = 'ENSNODE_SEPOLIA_V1_URL';
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
  ensnodeApiVersion: 'v1' | 'v2';
  rpcUrlEnvKey: RpcUrlEnvKey;
  ensnodeUrlEnvKey: EnsnodeUrlEnvKey;
  /**
   * Optional secondary v1 indexer (ENSNode subgraph) for networks whose primary
   * indexer is v2-only (zigens has no v1 data). Resolution order is v2 → v1 →
   * on-chain, so v1-only names on a v2 network still resolve via the indexer.
   */
  ensnodeV1UrlEnvKey?: EnsnodeV1UrlEnvKey;
  fallbackRpcEnvKeys: readonly FallbackRpcEnvKey[];
  /** Used only when no fallback env vars are set. */
  defaultFallbackRpcs: readonly string[];
  contracts: V1Contracts;
  v2: V2Contracts;
}

export const NETWORKS = {
  mainnet: {
    chain: mainnet,
    ensnodeApiVersion: 'v1',
    rpcUrlEnvKey: 'MAINNET_RPC_URL',
    ensnodeUrlEnvKey: 'ENSNODE_MAINNET_URL',
    ensnodeV1UrlEnvKey: undefined, // mainnet's primary indexer is already v1 (no v2 deployed)
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
    ensnodeApiVersion: 'v2',
    rpcUrlEnvKey: 'SEPOLIA_RPC_URL',
    ensnodeUrlEnvKey: 'ENSNODE_SEPOLIA_V2_URL',          // v2: zigens (graphql.ens.dev)
    ensnodeV1UrlEnvKey: 'ENSNODE_SEPOLIA_V1_URL',     // v1: ENSNode sepolia subgraph
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
    // ENS v2 (Sepolia) — aligned to zigens src/contracts.zig sepoliaAddresses.
    v2: {
      rootRegistry: '0xc960f7217d3643b525ef36bec8adf86953cd9ab8',  // root_registry
      ethRegistry: '0xdedb92913a25abe1f7bcdd85d8a344a43b398b67',   // eth_registry
      // Migration is handled by separate controllers (see src/utils/migration.ts).
      // zigens: migration_helper 0x11cfa7e034dafb7439cc1cc8b6e547f5c82ad021 (V1 side),
      // locked_migration_controller 0xf91c34ed840889ed96f806f882fd50506a336edb,
      // unlocked_migration_controller 0x056138ef5660f7113a3b0adc08ac3683310e7fbc (V2 side).
      migrationContract: '0xf91c34ed840889ed96f806f882fd50506a336edb', // locked_migration_controller
      // v2 resolvers are per-owner (no single canonical); last-resort fallback only.
      resolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
      // UniversalResolverV2 (sepolia), current deployment. findResolver() returns
      // the same resolvers graphql.ens.dev (the v2 indexer) reports, so on-chain
      // avatar/header resolution stays consistent with our metadata source.
      // (Supersedes the older march-deployment addresses, which return stale/null
      // resolvers for v2 names.) Used by BlockchainService.getResolverV2 and
      // AvatarService (avatar/header records).
      universalResolver: '0x2f8a180604c42457cb56c7c4f708748ff1f91df1',
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
