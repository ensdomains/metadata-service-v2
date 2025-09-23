import { createPublicClient, http, PublicClient, getContract } from 'viem';
import { mainnet } from 'viem/chains';
import { NetworkName, NetworkConfig } from '../types';

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

// Contract addresses
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