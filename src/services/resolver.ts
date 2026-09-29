import { getContract } from 'viem';
import { BlockchainService, CONTRACTS, NAME_WRAPPER_ABI } from './blockchain';
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
            const { result: [wrappedOwner, wrappedFuses, wrappedExpiry] } = await this.blockchain.executeWithFallback(
              network,
              (client) => getContract({
                address: CONTRACTS[network].nameWrapper as `0x${string}`,
                abi: NAME_WRAPPER_ABI,
                client,
              }).read.getData([BigInt(node)]),
              { markEndpointFailures: true },
            );
            registrant = wrappedOwner as string;
            fuses = Number(wrappedFuses);
            expiry = wrappedExpiry as bigint;
          } catch (error) {
            console.warn('Failed to get wrapper data:', error);
          }
        }
      }

      // Resolver records (addr/text/contenthash) are deliberately not read on
      // this path either: no caller consumes them, and the resolver is a
      // contract the name's owner chooses. Each read was an eth_call into that
      // code, repeated on every fallback RPC client when it fails and followed
      // through CCIP-Read when it reverts with OffchainLookup. Avatar/header
      // records are read through the ens-avatar UR path.

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
      },
      expirationDate: record.expiry ? new Date(Number(record.expiry) * 1000) : undefined,
    };
  }
}