import { BlockchainService } from './blockchain';
import { namehash, labelhash, isEmptyAddress } from '../utils/ens';
import { MIGRATION_STATUS, NetworkName, MigrationStatus } from '../types';
import { NotFoundError, UpstreamError } from './errors';

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
    const node = namehash(name);

    try {
      const data = await this.resolveFromNetwork(name, tokenId, node, preferredNetwork);
      return data;
    } catch (error) {
      // Preserve the resolution-layer taxonomy: NotFound (clean miss) and
      // Upstream (chain unreadable) must survive to the fallback tiers —
      // wrapping them in a plain Error collapses 404/503 semantics and lets a
      // partial outage masquerade as an ordinary per-level failure.
      if (error instanceof NotFoundError || error instanceof UpstreamError) throw error;
      console.error(`Failed to resolve ${name} from ${preferredNetwork}:`, error);
      throw new Error(`Unable to resolve ${name} from ${preferredNetwork}`);
    }
  }

  // Resolve from specific network. v2-aware: a name REGISTERED in the live v2
  // registry is read from v2 (owner/resolver/expiry); everything else uses the
  // legacy v1 registry.
  private async resolveFromNetwork(
    name: string,
    tokenId: string,
    node: `0x${string}`,
    network: NetworkName,
  ): Promise<NameData> {
    try {
      // v2 first where deployed: a migrated/native name's owner+resolver+expiry
      // live in the v2 registries — the v1 registry would return stale (or empty)
      // data for it. getV2NameRecord returns null when the name is not REGISTERED
      // on v2 (RESERVED placeholders included: those are still v1-authoritative).
      if (this.blockchain.isV2Configured(network)) {
        const v2Record = await this.blockchain.getV2NameRecord(network, name);
        if (v2Record) {
          return this.buildV2NameData(name, tokenId, network, v2Record);
        }
      }

      // Get basic registry data using enhanced methods (ENS v1 path)
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

      // This branch only runs when the name is NOT REGISTERED on v2 (see the
      // v2-first check above), so it is v1/unmigrated by construction.
      const migrationStatus = MIGRATION_STATUS.UNMIGRATED;

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
        version: 'v1',
        network,
        migrationStatus,
        resolver: resolverData,
        registrationDate,
        expirationDate,
      };
    } catch (error) {
      // Same taxonomy passthrough as resolveName above.
      if (error instanceof NotFoundError || error instanceof UpstreamError) throw error;
      console.error(`Failed to resolve ${name} from ${network}:`, error);
      throw new Error(`Unable to resolve ${name} from ${network}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * NameData for a name REGISTERED in the live v2 registry. Records (addr/text/
   * contenthash) are deliberately not fetched here: the metadata product doesn't
   * consume them from this path, and v2 resolvers can be wildcard/CCIP-Read —
   * avatar/header record reads go through the ens-avatar UR path instead.
   * `migrationStatus` is `migrated` because the on-chain view can prove
   * on-v2 vs not, but never `native` (that provenance lives only in the indexer).
   */
  private buildV2NameData(
    name: string,
    tokenId: string,
    network: NetworkName,
    record: { owner: string; resolver: string; expiry: bigint | null; status: number },
  ): NameData {
    return {
      name,
      tokenId,
      version: 'v2',
      network,
      migrationStatus: MIGRATION_STATUS.MIGRATED,
      resolver: {
        owner: record.owner,
        resolver: record.resolver,
        isWrapped: false,
        addresses: {},
        texts: {},
      },
      expirationDate: record.expiry ? new Date(Number(record.expiry) * 1000) : undefined,
    };
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

  // Check if name exists on network (v1 registry record OR live v2 registration)
  async nameExists(name: string, network: NetworkName): Promise<boolean> {
    try {
      const node = namehash(name);
      const { result } = await this.blockchain.executeWithFallback(network, async () => {
        const registry = this.blockchain.getContract(network, 'registry');
        return await registry.read.recordExists([node]);
      });
      if (result as boolean) return true;

      // Names born on v2 have no v1 registry record — check the v2 registry too.
      if (this.blockchain.isV2Configured(network)) {
        const v2 = await this.blockchain.getV2Registration(network, name);
        return v2?.status === 2;
      }
      return false;
    } catch (error) {
      console.error(`Error checking if ${name} exists on ${network}:`, error);
      return false;
    }
  }
}