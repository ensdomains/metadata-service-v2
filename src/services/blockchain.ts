import {
  createPublicClient,
  PublicClient,
  getContract,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  HttpRequestError,
  RawContractError,
  TimeoutError,
} from 'viem';
import { ccipBudgetedHttp, guardedCcipRequest } from './ccip-request';
import { NETWORKS, SUPPORTED_NETWORKS, type NetworkName, type V1Contracts, type V2Contracts } from '../config/networks';
import type { NetworkConfig } from '../types';
import { namehash, labelhash, canonicalizeName, dnsEncodeName, eth2ldLabel, isEmptyAddress } from '../utils/ens';
import { RequestDeadlineError, UpstreamError } from './errors';
import {
  beginRpcAttempt,
  deadlineFetch,
  endpointFailure,
  markEndpointFailed,
  raceRequestDeadline,
  timeLeftForAttempt,
} from './request-budget';

// Per-call RPC timeout. A healthy node answers an eth_call in well under a
// second; a primary plus three fallbacks at one attempt each (20s) fit the
// request deadline (request-budget.ts).
const RPC_TIMEOUT_MS = 5_000;

// Per-network contract address lookups, derived from the central registry
// (src/config/networks.ts). Typed by NetworkName so `CONTRACTS[network]` needs no cast.
export const CONTRACTS: Record<NetworkName, V1Contracts> =
  Object.fromEntries(SUPPORTED_NETWORKS.map((n) => [n, NETWORKS[n].contracts])) as Record<NetworkName, V1Contracts>;

export const ENS_V2_CONTRACTS: Record<NetworkName, V2Contracts> =
  Object.fromEntries(SUPPORTED_NETWORKS.map((n) => [n, NETWORKS[n].v2])) as Record<NetworkName, V2Contracts>;

// ABIs for ENS contracts
export const ENS_REGISTRY_ABI = [
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'resolver',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'owner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'recordExists',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const NAME_WRAPPER_ABI = [
  {
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'isWrapped',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // The token id (the node as an integer): getData(bytes32) does not exist.
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'getData',
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'fuses', type: 'uint32' },
      { name: 'expiry', type: 'uint64' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ENS v2 Registry ABI (PermissionedRegistry — shared by RootRegistry + ETHRegistry)
export const REGISTRY_V2_ABI = [
  {
    inputs: [{ name: 'label', type: 'string' }],
    name: 'getSubregistry',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'label', type: 'string' }],
    name: 'getResolver',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'anyId', type: 'uint256' }],
    name: 'getExpiry',
    outputs: [{ name: '', type: 'uint64' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'anyId', type: 'uint256' }],
    name: 'getStatus',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'anyId', type: 'uint256' }],
    name: 'getState',
    outputs: [
      {
        name: 'state',
        type: 'tuple',
        components: [
          { name: 'status', type: 'uint8' },
          { name: 'expiry', type: 'uint64' },
          { name: 'latestOwner', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'resource', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'uri',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  // String-keyed lookups (verified against the live sepolia ETHRegistry ABI via
  // Sourcify). These take the LABEL string directly, sidestepping the
  // tokenId-versioning scheme (tokenId = labelhash with the low 32 bits replaced
  // by the token version), and are the preferred read path.
  {
    inputs: [{ name: 'label', type: 'string' }],
    name: 'findExpiry',
    outputs: [{ name: '', type: 'uint64' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'label', type: 'string' }],
    name: 'findOwner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'label', type: 'string' }],
    name: 'findTokenId',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ENS v2 UniversalResolver ABI — the REAL IUniversalResolver interface
// (ensdomains/ens-contracts universalResolver/IUniversalResolver.sol, as used by
// contracts-v2 UniversalResolverV2). `findResolver` is a pure on-chain registry
// traversal (no CCIP-Read); `resolve`/`reverse` are EIP-3668/CCIP-Read (viem's
// readContract follows the OffchainLookup automatically).
export const UNIVERSAL_RESOLVER_V2_ABI = [
  {
    inputs: [{ name: 'name', type: 'bytes' }],
    name: 'findResolver',
    outputs: [
      { name: 'resolver', type: 'address' },
      { name: 'node', type: 'bytes32' },
      { name: 'resolverOffset', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }],
    name: 'resolve',
    outputs: [
      { name: 'result', type: 'bytes' },
      { name: 'resolver', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'lookupAddress', type: 'bytes' }, { name: 'coinType', type: 'uint256' }],
    name: 'reverse',
    outputs: [
      { name: 'primary', type: 'string' },
      { name: 'resolver', type: 'address' },
      { name: 'reverseResolver', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // The live root registry this UR walks — the discovery anchor for the current
  // v2 deployment (the registries move between redeployments; the UR proxy
  // address does not).
  {
    inputs: [],
    name: 'ROOT_REGISTRY',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Name-level owner lookup (DNS-encoded name, any depth) — pure on-chain walk.
  {
    inputs: [{ name: 'name', type: 'bytes' }],
    name: 'findOwner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const RESOLVER_ABI = [
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'addr',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
    name: 'text',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'bytes32' }],
    name: 'contenthash',
    outputs: [{ name: '', type: 'bytes' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// viem does not export its CCIP-read error classes; match them by name.
const OFFCHAIN_LOOKUP_ERRORS = new Set([
  'OffchainLookupError',
  'OffchainLookupResponseMalformedError',
  'OffchainLookupSenderMismatchError',
]);

/**
 * True when `error` says the RPC endpoint itself is down: it timed out, or it
 * could not be reached (an HttpRequestError with no HTTP status: connection
 * refused or reset). A 429 or 5xx, or a JSON-RPC rate limit, is often one
 * moment's load, not a reason to drop the endpoint for the rest of the
 * request. A revert, empty return data or a failed CCIP-read (whose gateway the
 * name's owner chooses) is an answer about the name, not about the endpoint.
 */
function isTransportFailure(error: unknown): boolean {
  let transport = false;
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 16; e = e.cause, depth++) {
    if (
      e instanceof ContractFunctionRevertedError ||
      e instanceof ContractFunctionZeroDataError ||
      e instanceof ExecutionRevertedError ||
      e instanceof RawContractError ||
      OFFCHAIN_LOOKUP_ERRORS.has(e.name)
    ) {
      return false;
    }
    if (e instanceof TimeoutError || (e instanceof HttpRequestError && e.status === undefined)) {
      transport = true;
    }
  }
  return transport;
}

export class BlockchainService {
  private clients: Map<NetworkName, PublicClient> = new Map();
  private fallbackClients: Map<NetworkName, PublicClient[]> = new Map();

  constructor(private env: {
    MAINNET_RPC_URL: string;
    SEPOLIA_RPC_URL: string;
    MAINNET_FALLBACK_RPC_1?: string;
    MAINNET_FALLBACK_RPC_2?: string;
    MAINNET_FALLBACK_RPC_3?: string;
    SEPOLIA_FALLBACK_RPC_1?: string;
    SEPOLIA_FALLBACK_RPC_2?: string;
  }) {
    this.initializeClients();
  }

  // Build primary + fallback clients for every network in the central registry.
  private initializeClients(): void {
    for (const network of SUPPORTED_NETWORKS) {
      const def = NETWORKS[network];

      const envFallbacks = def.fallbackRpcEnvKeys
        .map((key) => this.env[key])
        .filter(Boolean) as string[];
      // Fall back to the registry's public defaults only when none are configured.
      const fallbackUrls = envFallbacks.length > 0 ? envFallbacks : [...def.defaultFallbackRpcs];

      // One attempt per client: the next client in the chain is the retry.
      // viem also retries timeouts, so the old primary (8s, retryCount 2) alone
      // could hang for ~25s of the 30s request timeout before any fallback was
      // tried (WEB-1552). Only the last client, with nothing left to fail over
      // to, keeps one retry for transient errors (429/5xx). deadlineFetch aborts
      // every RPC fetch at the request's deadline.
      this.clients.set(network, createPublicClient({
        chain: def.chain,
        // CCIP-read gateway URLs come from resolver contracts anyone can deploy,
        // and the transport bounds how many lookups they can chain.
        ccipRead: { request: guardedCcipRequest },
        transport: ccipBudgetedHttp(this.env[def.rpcUrlEnvKey], {
          timeout: RPC_TIMEOUT_MS,
          retryCount: fallbackUrls.length === 0 ? 1 : 0,
          retryDelay: 500,
          fetchFn: deadlineFetch,
        }),
      }));

      this.fallbackClients.set(network, fallbackUrls.map((url, i) =>
        createPublicClient({
          chain: def.chain,
          ccipRead: { request: guardedCcipRequest },
          transport: ccipBudgetedHttp(url, {
            timeout: RPC_TIMEOUT_MS,
            retryCount: i === fallbackUrls.length - 1 ? 1 : 0,
            fetchFn: deadlineFetch,
          }),
        })
      ));
    }
  }

  // Get primary client for network
  getClient(network: NetworkName): PublicClient {
    const client = this.clients.get(network);
    if (!client) {
      throw new Error(`No client configured for network: ${network}`);
    }
    return client;
  }

  // Get all clients (primary + fallbacks) for network
  getAllClients(network: NetworkName): PublicClient[] {
    const primary = this.clients.get(network);
    const fallbacks = this.fallbackClients.get(network) || [];
    return primary ? [primary, ...fallbacks] : fallbacks;
  }

  // Execute call with automatic fallback. Inside a request, no client is tried
  // once the request's deadline is (nearly) spent, and each attempt is raced
  // against what is left of it: viem takes no per-call AbortSignal, and an
  // attempt can also wait on CCIP-read gateways. Both end in
  // RequestDeadlineError (an UpstreamError).
  //
  // Pass `markEndpointFailures` only for reads that run entirely in ENS's own
  // contracts (v1 registry, .eth registrar, NameWrapper, v2 root and .eth
  // registries, the UR's ROOT_REGISTRY). A resolver or a subregistry is chosen
  // by the name's owner and can burn gas until eth_call times out on a healthy
  // endpoint; marking it then would fail every other name's reads in the
  // request.
  async executeWithFallback<T>(
    network: NetworkName,
    operation: (client: PublicClient) => Promise<T>,
    { markEndpointFailures = false }: { markEndpointFailures?: boolean } = {},
  ): Promise<{ result: T; usedFallback: boolean }> {
    const clients = this.getAllClients(network);
    let lastError: Error | null = null;
    let skippedFailure: Error | undefined;

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      const isUsingFallback = i > 0;
      // An endpoint that already timed out or was unreachable in this request
      // is skipped by every read, so a hung primary costs one attempt per
      // request, not one per read. Keyed by URL, so a URL configured twice is
      // one endpoint; the URL may carry an API key, so the key is never logged.
      const url: unknown = client.transport.url;
      const endpoint = typeof url === 'string' ? `rpc:${url}` : `rpc:${network}:${i}`;
      const failure = endpointFailure(endpoint);
      if (failure) {
        skippedFailure = failure;
        continue;
      }

      const endAttempt = beginRpcAttempt();
      try {
        const what = `RPC client ${i} for ${network}`;
        const timeLeft = timeLeftForAttempt(what, lastError ?? undefined);
        const result = await raceRequestDeadline(operation(client), timeLeft, what);
        endAttempt();
        return { result, usedFallback: isUsingFallback };
      } catch (error) {
        // Only an attempt that cannot have waited in the connection queue can
        // blame the endpoint for a timeout (see beginRpcAttempt).
        const unqueued = endAttempt();
        if (error instanceof RequestDeadlineError) throw error;
        lastError = error as Error;
        if (markEndpointFailures && unqueued && isTransportFailure(error)) markEndpointFailed(endpoint, lastError);
        console.warn(`Client ${i} failed for ${network}:`, error);
        
        // If this is not the last client, continue to next
        if (i < clients.length - 1) {
          continue;
        }
      }
    }

    if (!lastError) {
      throw new UpstreamError(`All RPC clients for ${network} already failed in this request`, {
        cause: skippedFailure,
      });
    }

    // All clients failed — this IS the upstream-unreadable verdict, so type it:
    // every consumer (resolver walks, fallback tiers, expiry checks) keys its
    // outage-vs-miss decisions on `instanceof UpstreamError`.
    throw new UpstreamError(
      `All RPC clients failed for ${network}. Last error: ${lastError?.message}`,
      { cause: lastError ?? undefined }
    );
  }

  // Get contract instance
  getContract(
    network: NetworkName,
    contractType: 'registry' | 'registrar' | 'nameWrapper' | 'resolver',
    address?: string
  ) {
    const client = this.getClient(network);
    
    // Ensure network is supported
    if (!(network in CONTRACTS)) {
      throw new Error(`Unsupported network for contracts: ${network}`);
    }
    
    const contractAddress = address || CONTRACTS[network][contractType];

    let abi;
    switch (contractType) {
      case 'registry':
        abi = ENS_REGISTRY_ABI;
        break;
      case 'nameWrapper':
        abi = NAME_WRAPPER_ABI;
        break;
      case 'resolver':
        abi = RESOLVER_ABI;
        break;
      default:
        throw new Error(`Unknown contract type: ${contractType}`);
    }

    return getContract({
      address: contractAddress as `0x${string}`,
      abi,
      client,
    });
  }

  // Health check for blockchain connectivity
  async healthCheck(): Promise<{
    mainnet: { primary: boolean; fallbacks: boolean[] };
    sepolia: { primary: boolean; fallbacks: boolean[] };
  }> {
    const checkClient = async (client: PublicClient): Promise<boolean> => {
      try {
        await client.getBlockNumber();
        return true;
      } catch (error) {
        return false;
      }
    };

    const [mainnetResults, sepoliaResults] = await Promise.all([
      Promise.all([
        checkClient(this.clients.get('mainnet')!),
        ...(this.fallbackClients.get('mainnet') || []).map(checkClient),
      ]),
      Promise.all([
        checkClient(this.clients.get('sepolia')!),
        ...(this.fallbackClients.get('sepolia') || []).map(checkClient),
      ]),
    ]);

    return {
      mainnet: {
        primary: mainnetResults[0],
        fallbacks: mainnetResults.slice(1),
      },
      sepolia: {
        primary: sepoliaResults[0],
        fallbacks: sepoliaResults.slice(1),
      },
    };
  }

  // ── ENS v2 live-registry discovery ────────────────────────────────────────
  //
  // The v2 registries move between (unannounced) redeployments; the ONLY stable
  // address is the UpgradableUniversalResolverProxy vanity anchor. Discover the
  // live root/eth registries through it (UR.ROOT_REGISTRY() →
  // root.getSubregistry('eth')), cache per isolate with a TTL, and fall back to
  // the last-known configured addresses when discovery fails.
  private v2RegistryCache: Map<NetworkName, { root: `0x${string}`; eth: `0x${string}`; fetchedAt: number }> = new Map();
  private static readonly V2_REGISTRY_TTL_MS = 10 * 60 * 1000; // 10 minutes

  /** Whether ENS v2 is configured (deployed) on this network. A network with
   *  only placeholder strings has every v2 path disabled. */
  isV2Configured(network: NetworkName): boolean {
    return ENS_V2_CONTRACTS[network].universalResolver.startsWith('0x')
      || ENS_V2_CONTRACTS[network].ethRegistry.startsWith('0x');
  }

  /** Live root + eth registry addresses (discovered via the UR anchor, cached),
   *  or the configured last-known addresses when discovery is unavailable.
   *  Returns null when v2 isn't configured on the network at all. */
  async getV2Registries(network: NetworkName): Promise<{ root: `0x${string}`; eth: `0x${string}` } | null> {
    const v2 = ENS_V2_CONTRACTS[network];
    if (!this.isV2Configured(network)) return null;

    const cached = this.v2RegistryCache.get(network);
    if (cached && Date.now() - cached.fetchedAt < BlockchainService.V2_REGISTRY_TTL_MS) {
      return { root: cached.root, eth: cached.eth };
    }

    if (v2.universalResolver.startsWith('0x')) {
      try {
        const { result } = await this.executeWithFallback(network, async (client) => {
          const ur = getContract({
            address: v2.universalResolver as `0x${string}`,
            abi: UNIVERSAL_RESOLVER_V2_ABI,
            client,
          });
          const root = await ur.read.ROOT_REGISTRY() as `0x${string}`;
          const rootRegistry = getContract({ address: root, abi: REGISTRY_V2_ABI, client });
          const eth = await rootRegistry.read.getSubregistry(['eth']) as `0x${string}`;
          return { root, eth };
        }, { markEndpointFailures: true });
        if (!isEmptyAddress(result.eth)) {
          this.v2RegistryCache.set(network, { ...result, fetchedAt: Date.now() });
          const known = v2.ethRegistry.toLowerCase();
          if (result.eth.toLowerCase() !== known) {
            console.warn(`[v2] live eth registry ${result.eth} differs from configured ${v2.ethRegistry} on ${network} — using live (update config/networks.ts)`);
          }
          return result;
        }
      } catch (error) {
        console.warn(`[v2] registry discovery via UR failed on ${network}:`, error);
      }
    }

    // Discovery unavailable: prefer the most recent successful discovery even
    // past its TTL — the configured addresses rot silently across redeploys,
    // while an expired cache entry was verifiably live more recently. (A dead
    // post-redeploy registry still answers reads with AVAILABLE, so falling back
    // to stale config would misclassify live v2 names instead of erroring.)
    if (cached) {
      return { root: cached.root, eth: cached.eth };
    }

    // Last-known configured addresses (also the path when only registries are
    // configured without a UR).
    if (v2.rootRegistry.startsWith('0x') && v2.ethRegistry.startsWith('0x')) {
      return { root: v2.rootRegistry as `0x${string}`, eth: v2.ethRegistry as `0x${string}` };
    }
    return null;
  }

  // Check ENS v2 migration status via ETHRegistry.getStatus()
  // (IPermissionedRegistry.Status: AVAILABLE=0, RESERVED=1, REGISTERED=2).
  // AVAILABLE and RESERVED both count as unmigrated — RESERVED is a pre-seeded
  // placeholder that still resolves via v1 (see src/utils/migration.ts). Only
  // REGISTERED(2) means the name actually lives on v2.
  //
  // The ETHRegistry keys .eth 2LD labels: for `sub.foo.eth` the relevant entry is
  // `foo` (a subname's migration state follows its 2LD — see eth2ldLabel). Names
  // outside .eth have no ETHRegistry entry → unmigrated.
  //
  // Error contract: THROWS UpstreamError when the chain cannot be read (all RPCs
  // failed) — callers must decide their own safe degradation instead of this
  // function silently coercing an outage to `unmigrated`.
  async isUnmigratedName(network: NetworkName, name: string): Promise<boolean> {
    const registries = await this.getV2Registries(network);
    // v2 not deployed on this network (placeholders) → everything is v1.
    if (!registries) return true;

    // labelhash is case-sensitive but ENS names are not: hash the canonical label,
    // like the UR paths below — a raw mixed-case label would read the wrong slot
    // and misclassify a live v2 name as unmigrated.
    const label = eth2ldLabel(canonicalizeName(name));
    if (!label) return true; // non-.eth (or bare "eth") — no ETHRegistry entry

    try {
      const { result: status } = await this.executeWithFallback(network, async (client) => {
        const ethRegistry = getContract({ address: registries.eth, abi: REGISTRY_V2_ABI, client });
        return await ethRegistry.read.getStatus([BigInt(labelhash(label))]) as number;
      }, { markEndpointFailures: true });
      // Only REGISTERED(2) is truly on v2; AVAILABLE(0)/RESERVED(1) → unmigrated.
      return Number(status) !== 2;
    } catch (error) {
      throw new UpstreamError(`v2 migration check failed for ${name} on ${network}`, { cause: error });
    }
  }

  // Read a name's v2 registration (status + expiry + owner) from the live
  // ETHRegistry. The v2 expiry is authoritative for v2 names: a name can be live
  // on v2 while its old v1 registration has lapsed (e.g. fox.eth on sepolia).
  //
  // Returns null when v2 doesn't apply (not deployed on the network, or the name
  // has no ETHRegistry entry — non-.eth / bare "eth"). THROWS UpstreamError when
  // the chain cannot be read, so an RPC outage is never mistaken for
  // "not on v2" (which could otherwise 410 a live name off its lapsed v1 expiry).
  async getV2Registration(
    network: NetworkName,
    name: string,
  ): Promise<{ status: number; expiry: bigint; owner: string } | null> {
    const registries = await this.getV2Registries(network);
    if (!registries) return null;

    // Canonical label — same case-sensitivity constraint as isUnmigratedName.
    const label = eth2ldLabel(canonicalizeName(name));
    if (!label) return null;

    try {
      // Single getState() call returns status + expiry + owner together (vs
      // separate round-trips) — this is on the per-request hot path. `anyId`
      // accepts the raw labelhash (the registry canonicalizes internally;
      // verified against the live sepolia deployment).
      const { result: state } = await this.executeWithFallback(network, async (client) => {
        const ethRegistry = getContract({ address: registries.eth, abi: REGISTRY_V2_ABI, client });
        return await ethRegistry.read.getState([BigInt(labelhash(label))]) as {
          status: number; expiry: bigint; latestOwner: string;
        };
      }, { markEndpointFailures: true });
      return { status: Number(state.status), expiry: state.expiry, owner: state.latestOwner };
    } catch (error) {
      throw new UpstreamError(`v2 registration read failed for ${name} on ${network}`, { cause: error });
    }
  }

  /**
   * On-chain v2 record for the fallback tier (used when the indexers are down):
   * owner (any depth, via UR.findOwner over the DNS-encoded name), resolver (via
   * getResolverV2), and — for .eth 2LDs — status/expiry from the ETHRegistry.
   * Returns null when the name is not REGISTERED on v2 (then the v1 registry is
   * authoritative). Throws UpstreamError when the chain cannot be read.
   */
  async getV2NameRecord(
    network: NetworkName,
    name: string,
  ): Promise<{ owner: string; resolver: string; expiry: bigint | null; status: number } | null> {
    const registration = await this.getV2Registration(network, name);
    // Not on v2 (or v2 not applicable): AVAILABLE(0)/RESERVED(1) are still
    // v1-authoritative — see src/utils/migration.ts.
    if (!registration || registration.status !== 2) return null;

    const is2ld = name.split('.').length === 2;
    let owner = registration.owner;
    if (!is2ld) {
      // Subname: the 2LD's registry entry doesn't own it — resolve the actual
      // owner through the UR's name-level walk. The walk runs through
      // subregistries the name chooses, so it never marks an endpoint.
      const ur = ENS_V2_CONTRACTS[network].universalResolver;
      if (ur.startsWith('0x')) {
        const { result } = await this.executeWithFallback(network, async (client) => {
          const urContract = getContract({ address: ur as `0x${string}`, abi: UNIVERSAL_RESOLVER_V2_ABI, client });
          return await urContract.read.findOwner([dnsEncodeName(canonicalizeName(name))]) as string;
        });
        owner = result;
      }
    }

    const resolver = await this.getResolverV2(network, name);
    return {
      owner,
      resolver,
      // Per-label expiry below the 2LD lives in the sub-registries; only the 2LD
      // expiry is surfaced here (subname expiry → null, callers must not 410 on it).
      expiry: is2ld ? registration.expiry : null,
      status: registration.status,
    };
  }

  // Enhanced ENS resolution: get owner directly from registry
  async getOwner(network: NetworkName, node: string): Promise<string> {
    return this.executeWithFallback(network, async (client) => {
      const registry = getContract({
        address: CONTRACTS[network].registry as `0x${string}`,
        abi: ENS_REGISTRY_ABI,
        client,
      });

      return await registry.read.owner([node as `0x${string}`]) as string;
    }, { markEndpointFailures: true }).then(({ result }) => result);
  }

  // ENS v2: Get resolver with v2-aware routing logic
  async getResolverV2(network: NetworkName, name: string): Promise<string> {
    // Case 1: Unmigrated - use legacy v1 registry
    if (await this.isUnmigratedName(network, name)) {
      const node = namehash(name);
      return await this.getResolver(network, node);
    }

    // Case 2: On v2 — prefer the UniversalResolver proxy's findResolver() (single
    // canonical on-chain traversal, wildcard-aware); otherwise fall back to the
    // manual registry walk from the live root registry.
    const ur = ENS_V2_CONTRACTS[network].universalResolver;
    if (ur.startsWith('0x')) {
      try {
        return await this.findResolverViaUniversalResolver(network, ur as `0x${string}`, name);
      } catch (error) {
        console.warn(`UniversalResolver findResolver failed for ${name}, falling back to traversal:`, error);
      }
    }
    return await this.getResolverHierarchical(network, name);
  }

  // Resolve a name's resolver address via UniversalResolverV2.findResolver (the
  // canonical on-chain registry traversal; no CCIP-Read). Takes a DNS-encoded name.
  // The traversal runs through subregistries the name chooses, so it never
  // marks an endpoint.
  private async findResolverViaUniversalResolver(
    network: NetworkName,
    universalResolver: `0x${string}`,
    name: string,
  ): Promise<string> {
    const dnsName = dnsEncodeName(canonicalizeName(name));
    const { result } = await this.executeWithFallback(network, async (client) => {
      const ur = getContract({
        address: universalResolver,
        abi: UNIVERSAL_RESOLVER_V2_ABI,
        client,
      });
      const [resolver] = await ur.read.findResolver([dnsName]) as [string, string, bigint];
      return resolver;
    });
    return result;
  }

  // ENS v2: Hierarchical resolver lookup (for v2 registries). Walks label-by-label
  // from the live root registry (discovered via the UR anchor when available).
  // Below .eth the registries are the name's choice, so the walk never marks
  // an endpoint.
  async getResolverHierarchical(network: NetworkName, name: string): Promise<string> {
    const registries = await this.getV2Registries(network);
    // v2 not configured on this network (placeholders) — nothing to walk.
    if (!registries) return '0x0000000000000000000000000000000000000000';

    const labels = name.split('.').reverse(); // ['eth', 'bar', 'foo']

    let currentRegistry = registries.root;
    let resolverAddress = '0x0000000000000000000000000000000000000000';

    for (const label of labels) {
      try {
        const { result } = await this.executeWithFallback(network, async (client) => {
          const registry = getContract({ address: currentRegistry, abi: REGISTRY_V2_ABI, client });
          const [subregistry, resolver] = await Promise.all([
            registry.read.getSubregistry([label]) as Promise<string>,
            registry.read.getResolver([label]) as Promise<string>,
          ]);
          return { subregistry, resolver };
        });

        if (result.resolver !== '0x0000000000000000000000000000000000000000') {
          resolverAddress = result.resolver; // Most specific wins
        }

        // If no subregistry, we're done (wildcard case)
        if (result.subregistry === '0x0000000000000000000000000000000000000000') {
          break;
        }

        currentRegistry = result.subregistry as `0x${string}`;
      } catch (error) {
        // executeWithFallback exhausted every RPC for this read. Returning a
        // zero/partial resolver here would violate the module's error contract
        // (outage must never be coerced to empty state) — let callers degrade.
        throw new UpstreamError(
          `v2 registry walk failed at label "${label}" for ${name} on ${network}`,
          { cause: error },
        );
      }
    }

    return resolverAddress;
  }

  // Enhanced ENS resolution: get resolver address from registry (v1)
  async getResolver(network: NetworkName, node: string): Promise<string> {
    return this.executeWithFallback(network, async (client) => {
      const registry = getContract({
        address: CONTRACTS[network].registry as `0x${string}`,
        abi: ENS_REGISTRY_ABI,
        client,
      });

      return await registry.read.resolver([node as `0x${string}`]) as string;
    }, { markEndpointFailures: true }).then(({ result }) => result);
  }

  // Enhanced ENS resolution: get text record from resolver
  async getText(network: NetworkName, resolverAddress: string, node: string, key: string): Promise<string> {
    return this.executeWithFallback(network, async (client) => {
      const resolver = getContract({
        address: resolverAddress as `0x${string}`,
        abi: RESOLVER_ABI,
        client,
      });

      return await resolver.read.text([node as `0x${string}`, key]) as string;
    }).then(({ result }) => result);
  }

  // Enhanced ENS resolution: get address record from resolver
  async getAddr(network: NetworkName, resolverAddress: string, node: string, coinType: number = 60): Promise<string> {
    return this.executeWithFallback(network, async (client) => {
      const resolver = getContract({
        address: resolverAddress as `0x${string}`,
        abi: RESOLVER_ABI,
        client,
      });

      if (coinType === 60) {
        // ETH address (backwards compatibility)
        return await resolver.read.addr([node as `0x${string}`]) as string;
      } else {
        // Multi-coin address - need different ABI for this
        // For now, just return empty string for non-ETH addresses
        return '';
      }
    }).then(({ result }) => result);
  }

  // Enhanced ENS resolution: get contenthash from resolver
  async getContenthash(network: NetworkName, resolverAddress: string, node: string): Promise<string> {
    return this.executeWithFallback(network, async (client) => {
      const resolver = getContract({
        address: resolverAddress as `0x${string}`,
        abi: RESOLVER_ABI,
        client,
      });

      const result = await resolver.read.contenthash([node as `0x${string}`]);
      return result ? `0x${Buffer.from(result as any).toString('hex')}` : '0x';
    }).then(({ result }) => result);
  }

  // Enhanced ENS resolution: check if name is wrapped
  async isWrapped(network: NetworkName, node: string): Promise<boolean> {
    try {
      const owner = await this.getOwner(network, node);
      return owner.toLowerCase() === CONTRACTS[network].nameWrapper.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  // Enhanced ENS resolution: get expiry date for .eth names (0n = no such
  // registration). THROWS UpstreamError when the chain cannot be read — both
  // callers deliberately degrade at their own level (resolveFromNetwork drops
  // just the expiry field; checkExpiry fails open), so an outage is a visible
  // per-caller decision rather than being coerced to "no expiry" here.
  async getExpiry(network: NetworkName, labelhash: string): Promise<bigint> {
    return this.executeWithFallback(network, async (client) => {
      const registrar = getContract({
        address: CONTRACTS[network].registrar as `0x${string}`,
        abi: [
          {
            inputs: [{ name: 'id', type: 'uint256' }],
            name: 'nameExpires',
            outputs: [{ name: '', type: 'uint256' }],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        client,
      });

      return await registrar.read.nameExpires([BigInt(labelhash)]) as bigint;
    }, { markEndpointFailures: true }).then(({ result }) => result);
  }

  // Get network configuration
  getNetworkConfig(network: NetworkName): NetworkConfig {
    // Ensure network is supported
    if (!(network in CONTRACTS)) {
      throw new Error(`Unsupported network for configuration: ${network}`);
    }

    const contracts = CONTRACTS[network];

    return {
      name: network,
      rpcUrl: this.env[NETWORKS[network].rpcUrlEnvKey],
      contracts: {
        registry: contracts.registry,
        registrar: contracts.registrar,
        nameWrapper: contracts.nameWrapper,
      },
    };
  }
}