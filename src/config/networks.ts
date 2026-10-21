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
type BignameUrlEnvKey = 'BIGNAME_MAINNET_URL' | 'BIGNAME_SEPOLIA_URL';
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
  /** bigname REST API for this chain; it indexes ENSv1 and ENSv2 names alike. */
  bignameUrlEnvKey: BignameUrlEnvKey;
  /** Whether ENSv2 is deployed here, so the indexer can report v2 activity. */
  hasEnsV2: boolean;
  rpcUrlEnvKey: RpcUrlEnvKey;
  fallbackRpcEnvKeys: readonly FallbackRpcEnvKey[];
  /** Used only when no fallback env vars are set. */
  defaultFallbackRpcs: readonly string[];
  contracts: V1Contracts;
  v2: V2Contracts;
}

export const NETWORKS = {
  mainnet: {
    chain: mainnet,
    bignameUrlEnvKey: 'BIGNAME_MAINNET_URL',
    hasEnsV2: false,
    rpcUrlEnvKey: 'MAINNET_RPC_URL',
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
    bignameUrlEnvKey: 'BIGNAME_SEPOLIA_URL',
    hasEnsV2: true,
    rpcUrlEnvKey: 'SEPOLIA_RPC_URL',
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
