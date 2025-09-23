import { BlockchainService } from './blockchain';
import { namehash, labelhash, isEmptyAddress, tokenIdToHex, getTokenIdVersion } from '../utils/ens';
import { NetworkName, MigrationStatus } from '../types';

export interface ResolverData {
  owner: string;
  resolver: string;
  registrant?: string;
  expiry?: bigint;
  isWrapped: boolean;
  fuses?: number;
  addresses: Record<string, string>;
  texts: Record<string, string>;
  contenthash?: string;
}

export interface NameData {
  name: string;
  tokenId: string;
  version: 'v1' | 'v2';
  network: NetworkName;
  migrationStatus: MigrationStatus;
  resolver: ResolverData;
  registrationDate?: Date;
  expirationDate?: Date;
}

export class ResolverService {
  constructor(private blockchain: BlockchainService) {}

  // Resolve name data from either L1 or L2
  async resolveName(name: string, tokenId: string, preferredNetwork: NetworkName = 'namechain'): Promise<NameData> {
    const version = getTokenIdVersion(tokenId, name);
    const node = namehash(name);

    // Try preferred network first (usually L2/namechain for better performance)
    try {
      const data = await this.resolveFromNetwork(name, tokenId, node, preferredNetwork, version);
      if (data.resolver.owner && !isEmptyAddress(data.resolver.owner)) {
        return data;
      }
    } catch (error) {
      console.warn(`Failed to resolve from ${preferredNetwork}:`, error);
    }

    // Fallback to other network
    const fallbackNetwork: NetworkName = preferredNetwork === 'namechain' ? 'mainnet' : 'namechain';
    
    try {
      const data = await this.resolveFromNetwork(name, tokenId, node, fallbackNetwork, version);
      // Mark as using fallback
      data.migrationStatus = this.determineMigrationStatus(preferredNetwork, fallbackNetwork, data.resolver.owner);
      return data;
    } catch (error) {
      console.error(`Failed to resolve from both networks:`, error);
      throw new Error(`Unable to resolve ${name} from any network`);
    }
  }

  // Resolve from specific network
  private async resolveFromNetwork(
    name: string,
    tokenId: string,
    node: `0x${string}`,
    network: NetworkName,
    version: 'v1' | 'v2'
  ): Promise<NameData> {
    const { result: resolverData, usedFallback } = await this.blockchain.executeWithFallback(
      network,
      async (client) => {
        // Get basic registry data
        const registry = this.blockchain.getContract(network, 'registry');
        
        const [owner, resolver] = await Promise.all([
          registry.read.owner([node]),
          registry.read.resolver([node])
        ]);

        let registrant: string | undefined;
        let expiry: bigint | undefined;
        let isWrapped = false;
        let fuses: number | undefined;

        // Check if name is wrapped
        if (owner && !isEmptyAddress(owner as string)) {
          try {
            const nameWrapper = this.blockchain.getContract(network, 'nameWrapper');
            isWrapped = await nameWrapper.read.isWrapped([node]);
            
            if (isWrapped) {
              const [wrappedOwner, wrappedFuses, wrappedExpiry] = await nameWrapper.read.getData([node]);
              registrant = wrappedOwner as string;
              fuses = Number(wrappedFuses);
              expiry = wrappedExpiry as bigint;
            }
          } catch (error) {
            console.warn('Failed to check wrapper status:', error);
          }
        }

        // Get resolver records if resolver exists
        const addresses: Record<string, string> = {};
        const texts: Record<string, string> = {};
        let contenthash: string | undefined;

        if (resolver && !isEmptyAddress(resolver as string)) {
          try {
            const resolverContract = this.blockchain.getContract(network, 'resolver', resolver as string);
            
            // Get ETH address
            const ethAddress = await resolverContract.read.addr([node]);
            if (ethAddress && !isEmptyAddress(ethAddress as string)) {
              addresses.eth = ethAddress as string;
            }

            // Get common text records
            const textKeys = ['email', 'url', 'avatar', 'description', 'notice', 'keywords', 'discord', 'github', 'reddit', 'twitter'];
            const textResults = await Promise.allSettled(
              textKeys.map(key => resolverContract.read.text([node, key]))
            );

            textResults.forEach((result, index) => {
              if (result.status === 'fulfilled' && result.value) {
                texts[textKeys[index]] = result.value as string;
              }
            });

            // Get contenthash
            try {
              const contentHashResult = await resolverContract.read.contenthash([node]);
              if (contentHashResult && contentHashResult !== '0x') {
                contenthash = contentHashResult as string;
              }
            } catch (error) {
              // Contenthash not supported or empty
            }

          } catch (error) {
            console.warn('Failed to resolve records:', error);
          }
        }

        return {
          owner: owner as string,
          resolver: resolver as string,
          registrant,
          expiry,
          isWrapped,
          fuses,
          addresses,
          texts,
          contenthash,
        };
      }
    );

    // Determine migration status
    const migrationStatus = this.determineMigrationStatus('namechain', network, resolverData.owner);

    // Calculate registration and expiration dates
    let registrationDate: Date | undefined;
    let expirationDate: Date | undefined;

    if (resolverData.expiry) {
      expirationDate = new Date(Number(resolverData.expiry) * 1000);
    }

    return {
      name,
      tokenId,
      version,
      network,
      migrationStatus,
      resolver: resolverData,
      registrationDate,
      expirationDate,
    };
  }

  // Resolve multiple names in parallel
  async resolveMultiple(
    names: Array<{ name: string; tokenId: string }>,
    preferredNetwork: NetworkName = 'namechain'
  ): Promise<NameData[]> {
    const batchSize = 10; // Process in batches to avoid overwhelming RPC
    const results: NameData[] = [];

    for (let i = 0; i < names.length; i += batchSize) {
      const batch = names.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(({ name, tokenId }) => this.resolveName(name, tokenId, preferredNetwork))
      );

      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error(`Failed to resolve ${batch[index].name}:`, result.reason);
          // Could push a default/error state result here
        }
      });

      // Small delay between batches
      if (i + batchSize < names.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  // Check if name exists on network
  async nameExists(name: string, network: NetworkName): Promise<boolean> {
    try {
      const node = namehash(name);
      const { result } = await this.blockchain.executeWithFallback(network, async (client) => {
        const registry = this.blockchain.getContract(network, 'registry');
        return await registry.read.recordExists([node]);
      });
      
      return result as boolean;
    } catch (error) {
      console.error(`Error checking if ${name} exists on ${network}:`, error);
      return false;
    }
  }

  // Determine migration status based on where name was found
  private determineMigrationStatus(
    preferredNetwork: NetworkName,
    actualNetwork: NetworkName,
    owner: string
  ): MigrationStatus {
    if (isEmptyAddress(owner)) {
      return 'unmigrated';
    }

    if (preferredNetwork === 'namechain') {
      if (actualNetwork === 'namechain') {
        return 'native';
      } else {
        return 'ejected';
      }
    } else {
      // Legacy case - most names start on mainnet
      if (actualNetwork === 'mainnet') {
        return 'unmigrated';
      } else {
        return 'native';
      }
    }
  }

  // Get registration history for analytics
  async getRegistrationHistory(name: string): Promise<{
    originalRegistration?: Date;
    lastTransfer?: Date;
    migrationDate?: Date;
  }> {
    // This would involve scanning historical events
    // For now, return empty object as placeholder
    return {};
  }

  // Validate name resolution across networks
  async validateCrossChain(name: string, tokenId: string): Promise<{
    mainnet: boolean;
    namechain: boolean;
    consistent: boolean;
  }> {
    const [mainnetExists, namechainExists] = await Promise.all([
      this.nameExists(name, 'mainnet'),
      this.nameExists(name, 'namechain'),
    ]);

    return {
      mainnet: mainnetExists,
      namechain: namechainExists,
      consistent: mainnetExists === namechainExists,
    };
  }
}