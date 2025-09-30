import { createPublicClient, http, PublicClient, getContract, keccak256, toBytes } from 'viem';
import { mainnet } from 'viem/chains';
import { NetworkName, NetworkConfig } from '../types';
import { namehash } from '../utils/ens';

// Create Namechain L2 configuration dynamically
function createNamechainConfig(rpcUrl: string) {
  return {
    id: 1337803,
    name: 'Namechain',
    nativeCurrency: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    rpcUrls: {
      public: { http: [rpcUrl] },
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: { name: 'Explorer', url: 'https://explorer.namechain.network' },
    },
  } as const;
}

// ENS v1 Contract addresses (legacy - for unmigrated names)
export const CONTRACTS = {
  mainnet: {
    registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    registrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    nameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
    resolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
  },
  namechain: {
    registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    registrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    nameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
    resolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
  },
} as const;

// ENS v2 Contract addresses
// TODO: Replace placeholders with actual deployed addresses once available
// Contracts repo: https://github.com/ensdomains/namechain
export const ENS_V2_CONTRACTS = {
  mainnet: {
    // ENS v2 L1 contracts
    rootRegistry: 'ROOT_REGISTRY_L1_ADDRESS', // Root registry for all TLDs
    ethRegistry: 'MIGRATED_WRAPPED_NAME_REGISTRY_L1_ADDRESS', // MigratedWrappedNameRegistry for ejected .eth names
    fallbackResolver: 'ETH_TLD_RESOLVER_L1_ADDRESS', // ETHTLDResolver - Uses CCIP-Read to query L2
    migrationContract: 'L1_MIGRATION_CONTROLLER_ADDRESS', // L1UnlockedMigrationController or L1LockedMigrationController
    ejectionController: 'L1_BRIDGE_CONTROLLER_ADDRESS', // L1BridgeController for ejection

    // Legacy v1 contracts (keep for unmigrated name compatibility)
    legacyRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
    legacyNameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
    legacyResolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
  },
  namechain: {
    // ENS v2 L2 contracts
    rootRegistry: 'ROOT_REGISTRY_L2_ADDRESS', // Root registry (same structure as L1)
    ethRegistry: 'ETH_REGISTRY_L2_ADDRESS', // PermissionedRegistry - Authoritative .eth registry on L2
    registryDatastore: 'REGISTRY_DATASTORE_L2_ADDRESS', // RegistryDatastore - Universal storage for all registries
    migrationContract: 'L2_MIGRATION_CONTROLLER_ADDRESS', // L2 migration controller
    ejectionController: 'L2_BRIDGE_CONTROLLER_ADDRESS', // L2BridgeController for ejection
  },
} as const;

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

// ENS v2 IRegistry interface ABI
// Each registry implements these methods for hierarchical resolution
// Based on: https://github.com/ensdomains/namechain/blob/main/contracts/src/common/IRegistry.sol
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
] as const;

// ENS v2 RegistryDatastore ABI (L2)
// Universal storage contract for all registry data
// Based on: https://github.com/ensdomains/namechain/blob/main/contracts/src/common/IRegistryDatastore.sol
export const REGISTRY_DATASTORE_ABI = [
  {
    inputs: [{ name: 'registry', type: 'address' }, { name: 'id', type: 'uint256' }],
    name: 'getEntry',
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'expiry', type: 'uint64' },
          { name: 'tokenVersionId', type: 'uint32' },
          { name: 'subregistry', type: 'address' },
          { name: 'eacVersionId', type: 'uint32' },
          { name: 'resolver', type: 'address' },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'registry', type: 'address' },
      { name: 'id', type: 'uint256' },
      {
        name: 'entry',
        type: 'tuple',
        components: [
          { name: 'expiry', type: 'uint64' },
          { name: 'tokenVersionId', type: 'uint32' },
          { name: 'subregistry', type: 'address' },
          { name: 'eacVersionId', type: 'uint32' },
          { name: 'resolver', type: 'address' },
        ],
      },
    ],
    name: 'setEntry',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'id', type: 'uint256' }, { name: 'subregistry', type: 'address' }],
    name: 'setSubregistry',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'id', type: 'uint256' }, { name: 'resolver', type: 'address' }],
    name: 'setResolver',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ENS v2 L1 Fallback Resolver ABI (ETHTLDResolver)
// This resolver uses CCIP-Read to fetch data from L2 (viem handles CCIP-Read automatically)
// Based on: https://github.com/ensdomains/namechain/blob/main/contracts/src/L1/ETHTLDResolver.sol
export const FALLBACK_RESOLVER_ABI = [
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
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'contentType', type: 'uint256' }],
    name: 'contenthash',
    outputs: [{ name: '', type: 'bytes' }],
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
    NAMECHAIN_RPC_URL: string;
    MAINNET_FALLBACK_RPC_1?: string;
    MAINNET_FALLBACK_RPC_2?: string;
    MAINNET_FALLBACK_RPC_3?: string;
    NAMECHAIN_FALLBACK_RPC_1?: string;
    NAMECHAIN_FALLBACK_RPC_2?: string;
  }) {
    this.initializeClients();
  }

  private initializeClients(): void {
    // Primary mainnet client
    const mainnetClient = createPublicClient({
      chain: mainnet,
      transport: http(this.env.MAINNET_RPC_URL, {
        timeout: 30_000,
        retryCount: 3,
        retryDelay: 1000,
      }),
    });

    // Primary namechain client
    const namechainConfig = createNamechainConfig(this.env.NAMECHAIN_RPC_URL);
    const namechainClient = createPublicClient({
      chain: namechainConfig,
      transport: http(this.env.NAMECHAIN_RPC_URL, {
        timeout: 30_000,
        retryCount: 3,
        retryDelay: 1000,
      }),
    });

    this.clients.set('mainnet', mainnetClient);
    this.clients.set('namechain', namechainClient);

    // Setup fallback clients
    this.setupFallbackClients();
  }

  private setupFallbackClients(): void {
    // Mainnet fallbacks from environment variables
    const mainnetFallbackUrls = [
      this.env.MAINNET_FALLBACK_RPC_1,
      this.env.MAINNET_FALLBACK_RPC_2,
      this.env.MAINNET_FALLBACK_RPC_3,
    ].filter(Boolean) as string[];

    // If no fallback URLs provided, use default public RPCs
    if (mainnetFallbackUrls.length === 0) {
      mainnetFallbackUrls.push(
        'https://ethereum.publicnode.com',
        'https://rpc.ankr.com/eth',
        'https://cloudflare-eth.com'
      );
    }

    const mainnetFallbacks = mainnetFallbackUrls.map(url =>
      createPublicClient({
        chain: mainnet,
        transport: http(url, {
          timeout: 30_000,
          retryCount: 2,
        }),
      })
    );

    this.fallbackClients.set('mainnet', mainnetFallbacks);

    // Namechain fallbacks from environment variables
    const namechainFallbackUrls = [
      this.env.NAMECHAIN_FALLBACK_RPC_1,
      this.env.NAMECHAIN_FALLBACK_RPC_2,
    ].filter(Boolean) as string[];

    const namechainFallbacks = namechainFallbackUrls.map(url => {
      const namechainConfig = createNamechainConfig(url);
      return createPublicClient({
        chain: namechainConfig,
        transport: http(url, {
          timeout: 30_000,
          retryCount: 2,
        }),
      });
    });

    this.fallbackClients.set('namechain', namechainFallbacks);
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
    
    const contractAddress = address || CONTRACTS[network as keyof typeof CONTRACTS][contractType];

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
    namechain: { primary: boolean; fallbacks: boolean[] };
  }> {
    const checkClient = async (client: PublicClient): Promise<boolean> => {
      try {
        await client.getBlockNumber();
        return true;
      } catch (error) {
        return false;
      }
    };

    const [mainnetResults, namechainResults] = await Promise.all([
      Promise.all([
        checkClient(this.clients.get('mainnet')!),
        ...this.fallbackClients.get('mainnet')!.map(checkClient),
      ]),
      Promise.all([
        checkClient(this.clients.get('namechain')!),
        ...this.fallbackClients.get('namechain')!.map(checkClient),
      ]),
    ]);

    return {
      mainnet: {
        primary: mainnetResults[0],
        fallbacks: mainnetResults.slice(1),
      },
      namechain: {
        primary: namechainResults[0],
        fallbacks: namechainResults.slice(1),
      },
    };
  }

  // ENS v2: Check if a name is unmigrated (still on ENS v1)
  async isUnmigratedName(name: string): Promise<boolean> {
    try {
      const node = namehash(name);

      const registry = getContract({
        address: ENS_V2_CONTRACTS.mainnet.legacyRegistry as `0x${string}`,
        abi: ENS_REGISTRY_ABI,
        client: this.getClient('mainnet'),
      });

      const owner = await registry.read.owner([node as `0x${string}`]) as string;
      const migrationContract = ENS_V2_CONTRACTS.mainnet.migrationContract;

      // If owner is NOT migration contract AND not zero address, it's unmigrated
      return owner !== migrationContract &&
             owner !== '0x0000000000000000000000000000000000000000';
    } catch (error) {
      console.error('Error checking unmigrated status:', error);
      // Default to unmigrated to use safe legacy path
      return true;
    }
  }

  // ENS v2: Check if a name is ejected back to L1
  async isEjectedName(name: string): Promise<boolean> {
    try {
      // Only check for .eth 2LDs (ejection only applies to them)
      const labels = name.split('.');
      if (labels.length !== 2 || labels[1] !== 'eth') {
        return false;
      }

      const label = labels[0];
      const tokenId = BigInt(keccak256(toBytes(label)));

      const l1Registry = getContract({
        address: ENS_V2_CONTRACTS.mainnet.ethRegistry as `0x${string}`,
        abi: [...REGISTRY_V2_ABI, ...NAME_WRAPPER_ABI], // Needs ownerOf from ERC1155
        client: this.getClient('mainnet'),
      });

      // Try to get owner - if it succeeds and is not zero, name is ejected
      const owner = await l1Registry.read.ownerOf([tokenId]) as string;
      return owner !== '0x0000000000000000000000000000000000000000';
    } catch (error) {
      // If call fails, name doesn't exist on L1 v2 registry (not ejected)
      return false;
    }
  }

  // Enhanced ENS resolution: get owner directly from registry
  async getOwner(network: NetworkName, node: string): Promise<string> {
    return this.executeWithFallback(network, async (client) => {
      const registry = getContract({
        address: CONTRACTS[network as keyof typeof CONTRACTS].registry as `0x${string}`,
        abi: ENS_REGISTRY_ABI,
        client,
      });

      return await registry.read.owner([node as `0x${string}`]) as string;
    }).then(({ result }) => result);
  }

  // ENS v2: Get resolver with v2-aware routing logic
  async getResolverV2(network: NetworkName, name: string): Promise<string> {
    // For mainnet, check migration state and route appropriately
    if (network === 'mainnet') {
      // Case 1: Unmigrated - use legacy v1 registry
      if (await this.isUnmigratedName(name)) {
        const node = namehash(name);
        return await this.getResolver('mainnet', node);
      }

      // Case 2: Ejected to L1 - use hierarchical L1 v2 query
      if (await this.isEjectedName(name)) {
        return await this.getResolverHierarchical('mainnet', name);
      }

      // Case 3: On L2 - use L1 Fallback Resolver
      // This triggers CCIP-Read to L2 (viem handles it automatically!)
      return await this.getResolverViaFallback(name);
    }

    // For L2, use hierarchical query directly
    return await this.getResolverHierarchical(network, name);
  }

  // ENS v2: Get resolver via L1 Fallback Resolver (CCIP-Read to L2)
  // Viem automatically handles the CCIP-Read dance!
  private async getResolverViaFallback(name: string): Promise<string> {
    try {
      const node = namehash(name);

      const fallbackResolver = getContract({
        address: ENS_V2_CONTRACTS.mainnet.fallbackResolver as `0x${string}`,
        abi: FALLBACK_RESOLVER_ABI,
        client: this.getClient('mainnet'), // L1 client!
      });

      // This call will trigger CCIP-Read if needed
      // Viem handles the gateway requests and proof verification!
      // For now, we just try to get an addr record to verify resolver exists
      const addr = await fallbackResolver.read.addr([node as `0x${string}`]) as string;

      // If we got a response, the resolver exists and works
      // Return the fallback resolver address itself as it handles all queries
      return ENS_V2_CONTRACTS.mainnet.fallbackResolver;
    } catch (error) {
      console.error('CCIP-Read fallback failed:', error);
      return '0x0000000000000000000000000000000000000000';
    }
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
        address: CONTRACTS[network as keyof typeof CONTRACTS].registry as `0x${string}`,
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
      return owner.toLowerCase() === CONTRACTS[network as keyof typeof CONTRACTS].nameWrapper.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  // Enhanced ENS resolution: get expiry date for .eth names
  async getExpiry(network: NetworkName, labelhash: string): Promise<bigint | null> {
    try {
      return this.executeWithFallback(network, async (client) => {
        const registrar = getContract({
          address: CONTRACTS[network as keyof typeof CONTRACTS].registrar as `0x${string}`,
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

    const contracts = CONTRACTS[network as keyof typeof CONTRACTS];
    const client = this.getClient(network);

    return {
      name: network,
      rpcUrl: network === 'mainnet' ? this.env.MAINNET_RPC_URL : this.env.NAMECHAIN_RPC_URL,
      contracts: {
        registry: contracts.registry,
        registrar: contracts.registrar,
        nameWrapper: contracts.nameWrapper,
      },
    };
  }
}