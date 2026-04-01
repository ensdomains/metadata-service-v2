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

  // Resolve name data from the requested network
  async resolveName(name: string, tokenId: string, preferredNetwork: NetworkName = 'mainnet'): Promise<NameData> {
    const version = getTokenIdVersion(tokenId, name);
    const node = namehash(name);

    try {
      const data = await this.resolveFromNetwork(name, tokenId, node, preferredNetwork, version);
      return data;
    } catch (error) {
      console.error(`Failed to resolve ${name} from ${preferredNetwork}:`, error);
      throw new Error(`Unable to resolve ${name} from ${preferredNetwork}`);
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
    try {
      // Get basic registry data using enhanced methods
      // TODO: For ENS v2 support, use blockchain.getResolverV2(network, name) instead of getResolver(network, node)
      // This will properly route between unmigrated v1 and migrated v2 names
      const [owner, resolver] = await Promise.all([
        this.blockchain.getOwner(network, node),
        this.blockchain.getResolver(network, node)
      ]);

      let registrant: string | undefined;
      let expiry: bigint | undefined;
      let isWrapped = false;
      let fuses: number | undefined;

      // Check if name is wrapped using enhanced method
      if (owner && !isEmptyAddress(owner)) {
        isWrapped = await this.blockchain.isWrapped(network, node);

        if (isWrapped) {
          try {
            const nameWrapper = this.blockchain.getContract(network, 'nameWrapper');
            const [wrappedOwner, wrappedFuses, wrappedExpiry] = await nameWrapper.read.getData([node]);
            registrant = wrappedOwner as string;
            fuses = Number(wrappedFuses);
            expiry = wrappedExpiry as bigint;
          } catch (error) {
            console.warn('Failed to get wrapper data:', error);
          }
        }
      }

      // Get resolver records using enhanced methods
      const addresses: Record<string, string> = {};
      const texts: Record<string, string> = {};
      let contenthash: string | undefined;

      if (resolver && !isEmptyAddress(resolver)) {
        try {
          // Get ETH address using enhanced method
          const ethAddress = await this.blockchain.getAddr(network, resolver, node, 60);
          if (ethAddress && !isEmptyAddress(ethAddress)) {
            addresses.eth = ethAddress;
          }

          // Get common text records using enhanced method
          const textKeys = ['email', 'url', 'avatar', 'description', 'notice', 'keywords', 'discord', 'github', 'reddit', 'twitter'];
          const textResults = await Promise.allSettled(
            textKeys.map(key => this.blockchain.getText(network, resolver, node, key))
          );

          textResults.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
              texts[textKeys[index]] = result.value;
            }
          });

          // Get contenthash using enhanced method
          try {
            const contentHashResult = await this.blockchain.getContenthash(network, resolver, node);
            if (contentHashResult && contentHashResult !== '0x') {
              contenthash = contentHashResult;
            }
          } catch (error) {
            // Contenthash not supported or empty
          }

        } catch (error) {
          console.warn('Failed to resolve records:', error);
        }
      }

      // For .eth names, try to get expiry from registrar
      if (name.endsWith('.eth') && name.split('.').length === 2) {
        try {
          const labelHash = labelhash(name.split('.')[0]);
          const expiryResult = await this.blockchain.getExpiry(network, labelHash);
          if (expiryResult) {
            expiry = expiryResult;
          }
        } catch (error) {
          console.warn('Failed to get expiry from registrar:', error);
        }
      }

      // Determine migration status based on v1 vs v2 registry check
      const migrationStatus = this.determineMigrationStatus(network, owner);

      // Calculate registration and expiration dates
      let registrationDate: Date | undefined;
      let expirationDate: Date | undefined;

      if (expiry) {
        expirationDate = new Date(Number(expiry) * 1000);
      }

      const resolverData: ResolverData = {
        owner,
        resolver,
        registrant,
        expiry,
        isWrapped,
        fuses,
        addresses,
        texts,
        contenthash,
      };

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
    } catch (error) {
      console.error(`Failed to resolve ${name} from ${network}:`, error);
      throw new Error(`Unable to resolve ${name} from ${network}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Resolve multiple names in parallel
  async resolveMultiple(
    names: Array<{ name: string; tokenId: string }>,
    preferredNetwork: NetworkName = 'mainnet'
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

  // Determine migration status based on v1 vs v2 registry check on the target network
  private determineMigrationStatus(
    network: NetworkName,
    owner: string
  ): MigrationStatus {
    if (isEmptyAddress(owner)) {
      return 'unmigrated';
    }

    // TODO: Check v2 registry to determine if name is native v2 or migrated
    // For now, names with owners are considered unmigrated (v1) by default
    return 'unmigrated';
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
}