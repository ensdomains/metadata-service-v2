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

// ENS v2 contracts. Contracts not yet deployed on a network are placeholder strings
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
    // ENS v2 — ensdomains/contracts-v2 deployments/mainnet/addresses.md
    // (deployed 2026-10-18; v2_deployment_block 26105294); root.getSubregistry('eth')
    // verified on-chain 2026-10-19. Placeholder strings (not addresses) mark
    // what isn't live yet.
    v2: {
      rootRegistry: '0x2553c09be6447beffdb86fa622ad41fb8f77a91e',  // RootRegistry
      ethRegistry: '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2',   // ETHRegistry
      // Siblings (no runtime consumer): MigrationHelper 0x0b92006fa187b4c98d0a7dfc9d3b918b6d243485,
      // UnlockedMigrationController 0xab821ca676cf2e0790fa273526a165cfa86aeb64.
      migrationContract: '0xc46bf3b6c7ebcffd4ecfc3b012a1726a2463694d', // LockedMigrationController
      // v2 resolvers are per-owner (no single canonical); last-resort fallback only.
      resolver: '0x66f9f566ff2f26309c1bd9134388478a801da3e1', // PublicResolverV2
      // The vanity proxy still points at the v1 UR until the DAO proposal's last
      // call upgrades it to the ManagedUniversalResolverProxy
      // 0xcffd2ae680cd110d28739a70922636b5937b022b. Until then ROOT_REGISTRY()
      // reverts, so BlockchainService uses the registries above and walks them
      // itself; it switches to the proxy on its own once the probe answers.
      universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
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
    // ENS v2 (Sepolia) — 2026-09-15 deployment (the deploy's address list;
    // live-verified against the UR proxy on-chain 2026-09-29). These rot on every
    // silent redeploy; runtime UR discovery is authoritative, these are last-known.
    v2: {
      rootRegistry: '0x9703dbd26dab89504490994138cf2c575251a9ce',  // live RootRegistry (last-known; discovered via UR at runtime)
      ethRegistry: '0x657ea849311d3d5823348dded7c2aaafb3ede09e',   // live ETHRegistry (last-known; discovered via UR at runtime)
      // Migration is handled by separate controllers (see src/utils/migration.ts).
      // 2026-09-15 deployment siblings (no runtime consumer):
      // MigrationHelper 0x58d12d60471b98f191856e4c2d56886e9c3ea573 (V1 side),
      // UnlockedMigrationController 0x7ed171bb143a905f56105e4ea146543ecb122f55 (V2 side).
      migrationContract: '0xab1b57c6ee5e91e6090595c0af14cb9b8bc7773f', // LockedMigrationController
      // v2 resolvers are per-owner (no single canonical); last-resort fallback only.
      resolver: '0xd7e590ad0e92a6ac1d81f4483a9b951d3585a50f', // PublicResolverV2
      // UpgradableUniversalResolverProxy — the STABLE vanity address. NEVER pin a
      // UniversalResolverV2 implementation (currently 0x5d25c1d6acbb71b7a28aa7899618a3412a8303e3,
      // behind ManagedUniversalResolverProxy 0x6d80f2172cfdec5730fe683860c33d26fc42e6f1):
      // implementations walk whichever registries they were deployed with and go
      // dead on redeploys (the June one returned resolver=0 for live names,
      // verified 2026-07-14); the proxy tracks the current implementation +
      // registries. Used by BlockchainService (findResolver/findOwner + registry
      // discovery) and AvatarService (avatar/header records).
      universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
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
