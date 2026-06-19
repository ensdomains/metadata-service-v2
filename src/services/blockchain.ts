import { createPublicClient, http, PublicClient, getContract } from 'viem';
import { NETWORKS, SUPPORTED_NETWORKS, type NetworkName, type V1Contracts, type V2Contracts } from '../config/networks';
import type { NetworkConfig } from '../types';
import { namehash, labelhash, canonicalizeName, dnsEncodeName } from '../utils/ens';

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
    inputs: [{ name: 'node', type: 'bytes32' }],
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

      this.clients.set(network, createPublicClient({
        chain: def.chain,
        transport: http(this.env[def.rpcUrlEnvKey], {
          timeout: 30_000,
          retryCount: 3,
          retryDelay: 1000,
        }),
      }));

      const envFallbacks = def.fallbackRpcEnvKeys
        .map((key) => this.env[key])
        .filter(Boolean) as string[];
      // Fall back to the registry's public defaults only when none are configured.
      const fallbackUrls = envFallbacks.length > 0 ? envFallbacks : [...def.defaultFallbackRpcs];

      this.fallbackClients.set(network, fallbackUrls.map((url) =>
        createPublicClient({
          chain: def.chain,
          transport: http(url, { timeout: 30_000, retryCount: 2 }),
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

  // Execute call with automatic fallback
  async executeWithFallback<T>(
    network: NetworkName,
    operation: (client: PublicClient) => Promise<T>
  ): Promise<{ result: T; usedFallback: boolean }> {
    const clients = this.getAllClients(network);
    let lastError: Error | null = null;

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      const isUsingFallback = i > 0;

      try {
        const result = await operation(client);
        return { result, usedFallback: isUsingFallback };
      } catch (error) {
        lastError = error as Error;
        console.warn(`Client ${i} failed for ${network}:`, error);
        
        // If this is not the last client, continue to next
        if (i < clients.length - 1) {
          continue;
        }
      }
    }

    // All clients failed
    throw new Error(
      `All RPC clients failed for ${network}. Last error: ${lastError?.message}`
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

  // Check ENS v2 migration status via ETHRegistry.getStatus()
  // (IPermissionedRegistry.Status: AVAILABLE=0, RESERVED=1, REGISTERED=2).
  // AVAILABLE and RESERVED both count as unmigrated — RESERVED is a pre-seeded
  // placeholder that still resolves via v1 (see src/utils/migration.ts). Only
  // REGISTERED(2) means the name actually lives on v2.
  async isUnmigratedName(network: NetworkName, name: string): Promise<boolean> {
    try {
      const v2Contracts = ENS_V2_CONTRACTS[network];
      // Skip if v2 contracts aren't deployed yet (mainnet placeholders)
      if (v2Contracts.ethRegistry.startsWith('0x') === false) return true;

      const label = name.split('.')[0];
      const lhash = labelhash(label);

      const ethRegistry = getContract({
        address: v2Contracts.ethRegistry as `0x${string}`,
        abi: REGISTRY_V2_ABI,
        client: this.getClient(network),
      });

      const status = await ethRegistry.read.getStatus([BigInt(lhash)]) as number;
      // Only REGISTERED(2) is truly on v2; AVAILABLE(0)/RESERVED(1) → unmigrated.
      return status !== 2;
    } catch (error) {
      console.error('Error checking v2 migration status:', error);
      // Default to unmigrated to use safe legacy path
      return true;
    }
  }

  // Read a name's v2 registration (status + expiry) from the ETHRegistry.
  // Returns null when v2 isn't deployed on the network (mainnet placeholders) or
  // on error. The v2 expiry is authoritative for v2 names: a name can be live on
  // v2 while its old v1 registration has lapsed (e.g. fox.eth on sepolia).
  async getV2Registration(
    network: NetworkName,
    name: string,
  ): Promise<{ status: number; expiry: bigint } | null> {
    const v2Contracts = ENS_V2_CONTRACTS[network];
    if (v2Contracts.ethRegistry.startsWith('0x') === false) return null;
    try {
      const lhash = labelhash(name.split('.')[0]);
      const ethRegistry = getContract({
        address: v2Contracts.ethRegistry as `0x${string}`,
        abi: REGISTRY_V2_ABI,
        client: this.getClient(network),
      });
      // Single getState() call returns status + expiry together (vs separate
      // getStatus + getExpiry round-trips) — this is on the per-request hot path.
      const state = await ethRegistry.read.getState([BigInt(lhash)]) as {
        status: number; expiry: bigint;
      };
      return { status: Number(state.status), expiry: state.expiry };
    } catch (error) {
      console.warn(`Failed to read v2 registration for ${name}:`, error);
      return null;
    }
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
    }).then(({ result }) => result);
  }

  // ENS v2: Get resolver with v2-aware routing logic
  async getResolverV2(network: NetworkName, name: string): Promise<string> {
    // Case 1: Unmigrated - use legacy v1 registry
    if (await this.isUnmigratedName(network, name)) {
      const node = namehash(name);
      return await this.getResolver(network, node);
    }

    // Case 2: On v2 — prefer the real UniversalResolverV2.findResolver() when it is
    // deployed (single canonical on-chain traversal); otherwise fall back to the
    // manual registry walk from the root registry.
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
  private async findResolverViaUniversalResolver(
    network: NetworkName,
    universalResolver: `0x${string}`,
    name: string,
  ): Promise<string> {
    const ur = getContract({
      address: universalResolver,
      abi: UNIVERSAL_RESOLVER_V2_ABI,
      client: this.getClient(network),
    });
    const dnsName = dnsEncodeName(canonicalizeName(name));
    const [resolver] = await ur.read.findResolver([dnsName]) as [string, string, bigint];
    return resolver;
  }

  // ENS v2: Hierarchical resolver lookup (for v2 registries)
  async getResolverHierarchical(network: NetworkName, name: string): Promise<string> {
    const labels = name.split('.').reverse(); // ['eth', 'bar', 'foo']

    let currentRegistry = ENS_V2_CONTRACTS[network].rootRegistry as `0x${string}`;
    let resolverAddress = '0x0000000000000000000000000000000000000000';

    for (const label of labels) {
      const registry = getContract({
        address: currentRegistry,
        abi: REGISTRY_V2_ABI,
        client: this.getClient(network),
      });

      try {
        // Get subregistry for this label
        const subregistry = await registry.read.getSubregistry([label]) as string;

        // Get resolver for this label (might be wildcard)
        const resolver = await registry.read.getResolver([label]) as string;
        if (resolver !== '0x0000000000000000000000000000000000000000') {
          resolverAddress = resolver; // Most specific wins
        }

        // If no subregistry, we're done (wildcard case)
        if (subregistry === '0x0000000000000000000000000000000000000000') {
          break;
        }

        currentRegistry = subregistry as `0x${string}`;
      } catch (error) {
        console.error(`Error querying registry for label ${label}:`, error);
        break;
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
    }).then(({ result }) => result);
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

  // Enhanced ENS resolution: get expiry date for .eth names
  async getExpiry(network: NetworkName, labelhash: string): Promise<bigint | null> {
    try {
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
      }).then(({ result }) => result);
    } catch (error) {
      console.warn(`Failed to get expiry for ${labelhash}:`, error);
      return null;
    }
  }

  // Get network configuration
  getNetworkConfig(network: NetworkName): NetworkConfig {
    // Ensure network is supported
    if (!(network in CONTRACTS)) {
      throw new Error(`Unsupported network for configuration: ${network}`);
    }

    const contracts = CONTRACTS[network];
    const client = this.getClient(network);

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