// Metadata service that integrates ensnode, internal KV cache, and blockchain fallback
import { IndexerService, type IndexerDomain } from "./indexer";
import { CacheService, CacheKeys, CacheTTL } from "./cache";
import { BlockchainService } from "./blockchain";
import { ResolverService } from "./resolver";
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from "./fallback";
import { D1Service } from "./d1";
import { SyncService, DEFAULT_SYNC_CONFIG } from "./sync";
import type {
  MetadataResponse,
  MetadataAttribute,
  MigrationStatusResponse,
  RegistryHierarchyResponse,
  BatchMetadataResponse,
} from "../types/api";
import { MIGRATION_STATUS, type NetworkName, type MigrationStatus } from "../types";
import { classifyMigrationStatus, isReservedOwner } from "../utils/migration";
import { NotFoundError, UpstreamError } from "./errors";
import {
  validateEnsName,
  getLabel,
  namehash,
  labelhash,
  getCharacterSet,
  getSegmentLength,
  isNormalized,
  constructEthNameHash,
  Version,
  tokenIdToHex,
} from "../utils/ens";
import { CONTRACTS } from "./blockchain";

export class DomainExpiredError extends Error {
  constructor(name: string, expiryDate: Date) {
    super(`${name} is expired (expired ${expiryDate.toISOString()})`);
    this.name = 'DomainExpiredError';
  }
}

export interface BlockchainEnvironment {
  MAINNET_RPC_URL: string;
  SEPOLIA_RPC_URL: string;
  MAINNET_FALLBACK_RPC_1?: string;
  MAINNET_FALLBACK_RPC_2?: string;
  MAINNET_FALLBACK_RPC_3?: string;
  SEPOLIA_FALLBACK_RPC_1?: string;
  SEPOLIA_FALLBACK_RPC_2?: string;
}

export interface BlockchainNameData {
  name: string;
  tokenId: string;
  version: "v1" | "v2";
  network: NetworkName;
  resolver?: {
    isWrapped?: boolean;
    owner?: string;
    resolver?: string;
    id?: string;
    address?: string;
  };
  owner?: {
    id?: string;
  };
  parent?: BlockchainNameData;
}

export interface D1RecordData {
  name: string;
  labelhash: string;
  is_migrated: boolean;
  data_source: string;
  expiryDate?: string;
  expiry_date?: string;
  created_at?: string;
}

export interface MetadataServiceConfig {
  ensnodeEndpoint: string;
  ensnodeFallbackEndpoint?: string;
  ensnodeApiVersion?: 'v1' | 'v2';
  /** Optional secondary v1 ENSNode subgraph, queried after the primary v2 indexer
   *  misses (zigens is v2-only). Always queried with v1 ('namehash' id) semantics. */
  ensnodeV1Endpoint?: string;
  fallbackToBlockchain: boolean;
  internalCacheEnabled: boolean; // KV cache for internal optimizations
  d1Enabled: boolean;
  network?: NetworkName;
}

export class MetadataService {
  private network: NetworkName;
  public ensnode: IndexerService;
  private internalCache?: CacheService; // For internal optimizations only
  private cache: CacheService; // Backwards compatibility
  public blockchain: BlockchainService;
  private resolver: ResolverService;
  private fallback: FallbackService;
  private d1?: D1Service;
  private sync?: SyncService;

  constructor(
    config: MetadataServiceConfig,
    kv: KVNamespace,
    blockchainEnv: BlockchainEnvironment,
    db?: D1Database,
  ) {
    this.network = config.network || 'mainnet';
    this.ensnode = new IndexerService({
      primaryEndpoint: config.ensnodeEndpoint,
      fallbackEndpoint: config.ensnodeFallbackEndpoint,
      apiVersion: config.ensnodeApiVersion,
    });

    // Secondary v1 ENSNode subgraph (e.g. sepolia v1 names, which zigens lacks).
    const ensnodeV1 = config.ensnodeV1Endpoint
      ? new IndexerService({ primaryEndpoint: config.ensnodeV1Endpoint, apiVersion: 'v1' })
      : undefined;

    // Initialize internal cache for ensnode responses if enabled
    if (config.internalCacheEnabled) {
      this.internalCache = new CacheService(kv);
      this.cache = this.internalCache; // Backwards compatibility
    } else {
      // Create a no-op cache for backwards compatibility
      this.cache = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        deleteByPrefix: async () => 0,
        getStats: async () => ({ totalKeys: 0, keysSample: [] }),
      } as any;
    }

    this.blockchain = new BlockchainService(blockchainEnv);
    this.resolver = new ResolverService(this.blockchain);

    // Initialize fallback service with configuration
    const fallbackConfig = {
      ...DEFAULT_FALLBACK_CONFIG,
      blockchain: {
        ...DEFAULT_FALLBACK_CONFIG.blockchain,
        enabled: config.fallbackToBlockchain,
        preferredNetwork: this.network,
      },
    };
    this.fallback = new FallbackService(
      fallbackConfig,
      this.ensnode,
      this.blockchain,
      this.resolver,
      ensnodeV1,
    );

    // Initialize D1 and sync services if enabled
    if (config.d1Enabled && db) {
      this.d1 = new D1Service(db);
      this.sync = new SyncService(this.d1, this.ensnode, DEFAULT_SYNC_CONFIG);
    }
  }

  // Get metadata for a single domain (no API response caching - CF handles this)
  async getMetadata(
    network: NetworkName,
    registryType: "registry" | "namewrapper",
    identifier: string,
    baseUrl?: string,
  ): Promise<MetadataResponse> {
    // Validate identifier as ENS name
    if (!validateEnsName(identifier)) {
      throw new Error("Invalid ENS name format");
    }

    try {
      // Use comprehensive fallback service (internally cached)
      const {
        data: domain,
        source,
        usedFallback,
      } = await this.fallback.getDomainMetadata(identifier);

      // Check if domain is expired
      const domainData = domain as any;
      const expiryRaw = domainData.expiryDate || domainData.expiry_date;
      if (expiryRaw) {
        const expiryMs = typeof expiryRaw === 'string' && expiryRaw.includes('T')
          ? new Date(expiryRaw).getTime()
          : typeof expiryRaw === 'string'
            ? parseInt(expiryRaw, 10) * 1000
            : Number(expiryRaw) * 1000;
        if (expiryMs > 0 && expiryMs < Date.now()) {
          throw new DomainExpiredError(identifier, new Date(expiryMs));
        }
      }

      let metadata: MetadataResponse;

      if (source === "ensnode" || source === "ensnodeV1") {
        // `ensnodeV1` means the name came from the v1 ENSNode subgraph (absent from
        // the v2 indexer), so it is NOT on v2 → force `unmigrated` classification.
        metadata = await this.buildMetadataFromEnsnode(
          domain as IndexerDomain,
          network,
          baseUrl,
          source === "ensnode",
        );

        // Store in D1 if enabled
        if (this.d1 && this.sync) {
          await this.sync
            .syncDomain(identifier)
            .catch((error) =>
              console.warn(`Failed to sync ${identifier} to D1:`, error),
            );
        }
      } else {
        // Built from blockchain data
        metadata = await this.buildMetadataFromBlockchain(
          domain as unknown as BlockchainNameData,
          network,
          baseUrl,
        );
      }

      if (usedFallback) {
        console.warn(`Fallback to ${source} used for ${identifier}`);
      }

      return metadata;
    } catch (error) {
      // Expiry is a distinct, intentional outcome — propagate it unchanged (→ 410).
      if (error instanceof DomainExpiredError) throw error;

      console.error(`Failed to resolve metadata for ${identifier}:`, error);
      // Try D1 as last resort if available
      if (this.d1) {
        try {
          const d1Record = await this.d1.getDomain(identifier);
          if (d1Record) {
            console.warn(
              `Using stale D1 data for ${identifier} due to all other sources failing`,
            );

            // Convert D1 record to metadata
            const metadata = await this.buildMetadataFromD1Record(
              d1Record as D1RecordData,
              network,
              baseUrl,
            );
            return metadata;
          }
        } catch (d1Error) {
          console.error(`D1 fallback also failed for ${identifier}:`, d1Error);
        }
      }

      // Preserve the taxonomy from the fallback layer: NotFound → 404, Upstream →
      // 503. Anything else is unexpected (e.g. a build bug) → generic 500, NOT a
      // 404 (which would mask real failures as "name doesn't exist").
      if (error instanceof NotFoundError || error instanceof UpstreamError) throw error;
      throw new Error(`Failed to resolve metadata for ${identifier}`);
    }
  }

  // Check if a .eth domain is expired by querying the registrar
  async checkExpiry(name: string): Promise<void> {
    if (!name.endsWith('.eth') || name.split('.').length !== 2) return;
    try {
      // v2 is authoritative where deployed: a name can be live on v2 with a future
      // expiry while its old v1 registration has lapsed (e.g. fox.eth on sepolia is
      // REGISTERED on v2 until 2028 but expired on the v1 registrar in Feb 2026).
      // Only fall back to the v1 registrar expiry when the name is not on v2.
      const v2 = await this.blockchain.getV2Registration(this.network, name);
      if (v2 && v2.status === 2) {
        if (v2.expiry && Number(v2.expiry) * 1000 < Date.now()) {
          throw new DomainExpiredError(name, new Date(Number(v2.expiry) * 1000));
        }
        return; // live on v2 — ignore any lapsed v1 registration
      }

      const label = name.split('.')[0];
      const hash = labelhash(label);
      const expiry = await this.blockchain.getExpiry(this.network, hash);
      if (expiry && Number(expiry) * 1000 < Date.now()) {
        throw new DomainExpiredError(name, new Date(Number(expiry) * 1000));
      }
    } catch (error) {
      if (error instanceof DomainExpiredError) throw error;
      console.warn(`Failed to check expiry for ${name}:`, error);
    }
  }

  /**
   * Single-pass resolve for image/rasterize rendering: returns the name's
   * MigrationStatus (for the badge) AND enforces existence — throws NotFoundError
   * if the name isn't registered in any source (so the caller 404s), or
   * UpstreamError (→503) on a transient outage rather than a false 404. This
   * replaces a separate classifyName + existence check (one indexer round-trip
   * instead of two) and reuses the same source→status mapping as getMigrationStatus.
   */
  async resolveStatusForImage(network: NetworkName, name: string): Promise<MigrationStatus> {
    if (!validateEnsName(name)) {
      throw new Error('Invalid ENS name format');
    }
    // Throws NotFoundError when nothing can resolve the name.
    const { data, source } = await this.fallback.getDomainMetadata(name);
    return this.statusFromSource(source, network, name, data as any);
  }

  // Resolve v1 contract address + tokenId to ENS name
  async resolveTokenId(
    network: NetworkName,
    contractAddress: string,
    tokenId: string,
  ): Promise<{ name: string; registryType: 'registry' | 'namewrapper' }> {
    const contracts = CONTRACTS[network];
    const addr = contractAddress.toLowerCase();

    let registryType: 'registry' | 'namewrapper';
    let nameHash: string;

    if (addr === contracts.registrar.toLowerCase()) {
      // BaseRegistrar: tokenId is labelhash → convert to .eth namehash
      registryType = 'registry';
      nameHash = constructEthNameHash(tokenId, Version.v1);
    } else if (addr === contracts.nameWrapper.toLowerCase()) {
      // NameWrapper: tokenId is already a namehash
      registryType = 'namewrapper';
      nameHash = tokenIdToHex(tokenId);
    } else {
      throw new NotFoundError(`Unknown contract address: ${contractAddress}`);
    }

    const { domain } = await this.ensnode.getDomainByNamehash(nameHash);

    if (!domain?.name) {
      throw new NotFoundError(`No domain found for tokenId ${tokenId}`);
    }

    return { name: domain.name, registryType };
  }

  /**
   * Network-aware v1→v2 classification for a name → canonical MigrationStatus.
   * Single source of truth shared by metadata assembly, image generation, and
   * webhook warming (replaces the previously-duplicated inline detection).
   *
   * Sepolia uses the v2 indexer: a name present in the index is on v2, but a
   * RESERVED placeholder (owner == address(0), pre-seeded from v1) is still
   * `unmigrated`; otherwise the indexer's `isMigrated` flag distinguishes
   * `migrated` (from v1) from `native` (born on v2 — flag clear); absence ⇒
   * `unmigrated`. Mainnet uses the on-chain `ETHRegistry.getStatus()` check
   * (placeholder-guarded until mainnet v2 is deployed). Falls back to
   * `unmigrated` on any error.
   */
  async classifyName(network: NetworkName, name: string): Promise<MigrationStatus> {
    try {
      if (network === 'sepolia') {
        const { domain } = await this.ensnode.getDomain(name);
        if (!domain) return classifyMigrationStatus({ isUnmigrated: true });
        return this.classifyV2IndexerDomain(domain);
      }
      const isUnmigrated = await this.blockchain.isUnmigratedName(network, name);
      return classifyMigrationStatus({ isUnmigrated, isOnV2: !isUnmigrated });
    } catch {
      return MIGRATION_STATUS.UNMIGRATED;
    }
  }

  /**
   * Single source of truth for classifying a domain record that came from the
   * **v2 indexer** (zigens). Present in the index ⇒ on v2, unless it is a RESERVED
   * placeholder (owner == address(0)) which is still `unmigrated`; otherwise the
   * indexer's `isMigrated` flag distinguishes `migrated` (from v1) from `native`
   * (born on v2 — flag clear). Used by classifyName, getMigrationStatus, and
   * buildMetadataFromEnsnode so they cannot drift.
   *
   * NB: this must ONLY be fed v2-indexer data. v1-indexer (`ensnodeV1`) results are
   * `unmigrated`, and `blockchain`-sourced results use the on-chain status check
   * (which can never prove `native`) — see getMigrationStatus / buildMetadata*.
   */
  private classifyV2IndexerDomain(
    data: { isMigrated?: boolean; owner?: { id?: string }; ownerId?: string },
  ): MigrationStatus {
    return classifyMigrationStatus({
      isOnV2: true,
      isReserved: isReservedOwner(data.owner?.id ?? data.ownerId),
      bornOnV2: data.isMigrated === false,
    });
  }

  /**
   * Map a fallback-resolved record to a MigrationStatus, by source. Shared by
   * getMigrationStatus and the image path so they can't drift:
   *  - `ensnodeV1` (v1 ENSNode subgraph) → `unmigrated`
   *  - `ensnode` on sepolia (zigens/v2 indexer) → v2 indexer classification
   *  - `blockchain`, or `ensnode` on mainnet (v1 ENSNode subgraph) → on-chain
   *    registry status only (can prove on-v2 vs not, never `native`).
   */
  private async statusFromSource(
    source: 'ensnode' | 'ensnodeV1' | 'blockchain',
    network: NetworkName,
    name: string,
    data: { isMigrated?: boolean; owner?: { id?: string }; ownerId?: string },
  ): Promise<MigrationStatus> {
    if (source === 'ensnodeV1') {
      return classifyMigrationStatus({ isUnmigrated: true });
    }
    if (source === 'ensnode' && network === 'sepolia') {
      return this.classifyV2IndexerDomain(data);
    }
    const isUnmigrated = await this.blockchain.isUnmigratedName(network, name);
    return classifyMigrationStatus({ isUnmigrated, isOnV2: !isUnmigrated });
  }

  // Get migration status (CF cache handles API response caching)
  async getMigrationStatus(name: string): Promise<MigrationStatusResponse> {
    if (!validateEnsName(name)) {
      throw new Error("Invalid ENS name format");
    }

    try {
      // Use comprehensive fallback service (internally cached)
      const {
        data: status,
        source,
        usedFallback,
      } = await this.fallback.getMigrationStatus(name);

      let response: MigrationStatusResponse;

      const migrationStatus = await this.statusFromSource(source, this.network, name, status as any);

      response = {
        name,
        status: migrationStatus,
        l1Owner: (status as any).owner?.id,
        expirationDate: (status as any).expiryDate,
      };

      if (usedFallback) {
        console.warn(
          `Fallback to ${source} used for migration status of ${name}`,
        );
      }

      return response;
    } catch (error) {
      // Try D1 as last resort if available
      if (this.d1) {
        try {
          const d1Record = await this.d1.getMigrationStatus(name);
          if (d1Record) {
            console.warn(
              `Using stale D1 migration data for ${name} due to all other sources failing`,
            );

            const fallbackResponse: MigrationStatusResponse = {
              name: d1Record.name,
              status: d1Record.status,
              l1Owner: d1Record.l1_owner ?? undefined,
              expirationDate: d1Record.expiration_date ?? undefined,
            };

            return fallbackResponse;
          }
        } catch (d1Error) {
          console.error(
            `D1 migration fallback also failed for ${name}:`,
            d1Error,
          );
        }
      }

      console.error(
        `All fallback options failed for migration status of ${name}:`,
        error,
      );

      // Last resort fallback response
      const fallbackResponse: MigrationStatusResponse = {
        name,
        status: MIGRATION_STATUS.UNMIGRATED,
      };

      return fallbackResponse;
    }
  }

  // Get registry hierarchy
  async getRegistryHierarchy(name: string): Promise<RegistryHierarchyResponse> {
    if (!validateEnsName(name)) {
      throw new Error("Invalid ENS name format");
    }

    const cacheKey = CacheKeys.hierarchy(name, this.network);

    // Try cache first
    const cached = await this.cache.get<RegistryHierarchyResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Use comprehensive fallback service
      const {
        data: hierarchy,
        source,
        usedFallback,
      } = await this.fallback.getRegistryHierarchy(name);

      let response: RegistryHierarchyResponse;

      if (source === "ensnode") {
        response = this.buildHierarchyResponse(hierarchy as any, name);
        // Cache with ensnode TTL for ensnode data
        await this.cache.set(cacheKey, response, { ttl: CacheTTL.ensnode });
      } else {
        // Built from blockchain data
        response = this.buildHierarchyResponseFromBlockchain(
          hierarchy as any,
          name,
        );
        // Cache with shorter TTL for blockchain-sourced data
        await this.cache.set(cacheKey, response, { ttl: CacheTTL.error });
      }

      if (usedFallback) {
        console.warn(`Fallback to ${source} used for hierarchy of ${name}`);
      }

      return response;
    } catch (error) {
      // Try D1 as last resort if available
      if (this.d1) {
        try {
          const d1Records = await this.d1.getHierarchy(name);
          if (d1Records.length > 0) {
            console.warn(
              `Using stale D1 hierarchy data for ${name} due to all other sources failing`,
            );

            const fallbackResponse: RegistryHierarchyResponse = {
              name,
              hierarchy: d1Records.map((record) => ({
                name: record.name,
                owner: record.owner,
                resolver: record.resolver,
                level: record.level,
              })),
            };

            // Cache briefly to avoid repeated D1 queries
            await this.cache.set(cacheKey, fallbackResponse, {
              ttl: CacheTTL.error,
            });
            return fallbackResponse;
          }
        } catch (d1Error) {
          console.error(
            `D1 hierarchy fallback also failed for ${name}:`,
            d1Error,
          );
        }
      }

      console.error(
        `All fallback options failed for hierarchy of ${name}:`,
        error,
      );

      // Generate basic hierarchy as last resort
      const fallbackResponse = this.generateBasicHierarchy(name);
      await this.cache.set(cacheKey, fallbackResponse, { ttl: CacheTTL.error });
      return fallbackResponse;
    }
  }

  // Get batch metadata
  async getBatchMetadata(
    names: string[],
    network?: NetworkName,
    baseUrl?: string,
  ): Promise<BatchMetadataResponse> {
    // Validate all names
    const validNames = names.filter((name) => validateEnsName(name));

    if (validNames.length === 0) {
      return {
        results: [],
        total: 0,
        successful: 0,
        failed: names.length,
      };
    }

    try {
      // Try batch query from ensnode
      const { domains } = await this.ensnode.getDomains(validNames);

      // Build results
      const results = await Promise.allSettled(
        validNames.map(async (name) => {
          // Check expiry first
          await this.checkExpiry(name);

          const domain = domains.find((d) => d.name === name);

          if (domain) {
            // Also check ensnode expiryDate
            const expiryRaw = domain.expiryDate;
            if (expiryRaw) {
              const expiryMs = typeof expiryRaw === 'string' && expiryRaw.includes('T')
                ? new Date(expiryRaw).getTime()
                : parseInt(expiryRaw, 10) * 1000;
              if (expiryMs > 0 && expiryMs < Date.now()) {
                return { name, error: `${name} is expired` };
              }
            }

            const metadata = await this.buildMetadataFromEnsnode(
              domain,
              network || "mainnet",
              baseUrl,
            );
            return { name, metadata };
          } else {
            // Try individual fallback for missing domains
            try {
              const metadata = await this.getMetadata(
                network || "mainnet",
                "registry",
                name,
                baseUrl,
              );
              return { name, metadata };
            } catch (err) {
              if (err instanceof DomainExpiredError) {
                return { name, error: err.message };
              }
              return { name, error: `Failed to resolve ${name}` };
            }
          }
        }),
      );

      // Process results
      const response: BatchMetadataResponse = {
        results: results.map((result, i) => {
          if (result.status === "fulfilled") {
            return result.value;
          } else {
            const reason = result.reason;
            if (reason instanceof DomainExpiredError) {
              return { name: validNames[i], error: reason.message };
            }
            return { name: validNames[i], error: "Processing failed" };
          }
        }),
        total: validNames.length,
        successful: results.filter(
          (r) => r.status === "fulfilled" && !("error" in r.value),
        ).length,
        failed: results.filter(
          (r) => r.status === "rejected" || "error" in (r as any).value,
        ).length,
      };

      return response;
    } catch (error) {
      console.error("Batch metadata query failed:", error);

      // Try blockchain fallback for batch metadata
      console.warn(
        "Falling back to individual blockchain queries for batch metadata",
      );

      const fallbackResults = await Promise.allSettled(
        validNames.map(async (name) => {
          try {
            const metadata = await this.getMetadata(
              network || "mainnet",
              "registry",
              name,
              baseUrl,
            );
            return { name, metadata };
          } catch {
            return { name, error: `Failed to resolve ${name}` };
          }
        }),
      );

      return {
        results: fallbackResults.map((result) =>
          result.status === "fulfilled"
            ? result.value
            : { name: "", error: "Processing failed" },
        ),
        total: validNames.length,
        successful: fallbackResults.filter(
          (r) => r.status === "fulfilled" && !("error" in r.value),
        ).length,
        failed: fallbackResults.filter(
          (r) => r.status === "rejected" || "error" in (r as any).value,
        ).length,
      };
    }
  }

  // Build metadata response from ensnode domain data.
  // `onV2` is false when the domain came from the v1 ENSNode subgraph fallback
  // (name absent from the v2 indexer) → it is a v1 name, classified `unmigrated`.
  private async buildMetadataFromEnsnode(
    domain: IndexerDomain,
    network: NetworkName,
    baseUrl?: string,
    onV2: boolean = true,
  ): Promise<MetadataResponse> {
    // Determine ENS v2 migration status. A v2-sourced domain is on v2 — unless it
    // is a RESERVED placeholder (owner == address(0)), which is still `unmigrated`;
    // otherwise its `isMigrated` flag distinguishes `migrated` from `native`. A
    // v1-sourced domain (`onV2 === false`) is `unmigrated`. For mainnet, use the
    // on-chain check.
    let v2MigrationStatus: MigrationStatus;
    if (!onV2) {
      v2MigrationStatus = classifyMigrationStatus({ isUnmigrated: true });
    } else if (this.network === 'sepolia' && domain.isMigrated !== undefined) {
      // v2 indexer (zigens) domain — reuse the record we already fetched.
      v2MigrationStatus = this.classifyV2IndexerDomain(domain);
    } else {
      const isUnmigrated = await this.blockchain.isUnmigratedName(network, domain.name);
      v2MigrationStatus = classifyMigrationStatus({ isUnmigrated, isOnV2: !isUnmigrated });
    }

    const origin = baseUrl || this.getDefaultBaseUrl();
    const imageUrl = `${origin}/${network}/registry/${encodeURIComponent(domain.name)}/image`;

    return {
      is_normalized: isNormalized(domain.name),
      name: domain.name,
      description: this.generateDescription(domain.name),
      attributes: this.buildAttributes(domain, v2MigrationStatus),
      url: `https://app.ens.domains/name/${domain.name}`,
      last_request_date: Date.now(),
      version: 0,
      background_image: `${origin}/${network}/avatar/${domain.name}`,
      image: imageUrl,
      image_url: imageUrl,
    };
  }

  // Build metadata response from blockchain data
  private async buildMetadataFromBlockchain(
    nameData: BlockchainNameData,
    network: NetworkName,
    baseUrl?: string,
  ): Promise<MetadataResponse> {
    // Use the request's network for self-URLs — the blockchain fallback record
    // doesn't carry one (nameData.network was undefined → `/undefined/` URLs).
    const origin = baseUrl || this.getDefaultBaseUrl();
    const imageUrl = `${origin}/${network}/registry/${encodeURIComponent(nameData.name)}/image`;

    return {
      is_normalized: isNormalized(nameData.name),
      name: nameData.name,
      description: this.generateDescription(nameData.name),
      attributes: this.buildAttributesFromBlockchain(nameData),
      url: `https://app.ens.domains/name/${nameData.name}`,
      last_request_date: Date.now(),
      version: 0,
      background_image: `${origin}/${network}/avatar/${nameData.name}`,
      image: imageUrl,
      image_url: imageUrl,
    };
  }

  // Build metadata response from D1 record
  private async buildMetadataFromD1Record(
    record: D1RecordData,
    network: NetworkName,
    baseUrl?: string,
  ): Promise<MetadataResponse> {
    const origin = baseUrl || this.getDefaultBaseUrl();
    const imageUrl = `${origin}/${network}/registry/${encodeURIComponent(record.name)}/image`;

    return {
      is_normalized: isNormalized(record.name),
      name: record.name,
      description: this.generateDescription(record.name),
      attributes: this.buildAttributesFromD1Record(record),
      url: `https://app.ens.domains/name/${record.name}`,
      last_request_date: Date.now(),
      version: 0,
      background_image: `${origin}/${network}/avatar/${record.name}`,
      image: imageUrl,
      image_url: imageUrl,
    };
  }

  // Build hierarchy response from ensnode data
  private buildHierarchyResponse(
    hierarchy: IndexerDomain,
    name: string,
  ): RegistryHierarchyResponse {
    const levels: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    const level = this.getDomainLevel(name);

    // Just add the current domain for now
    levels.push({
      name: hierarchy.name,
      owner:
        hierarchy.owner?.id || "0x0000000000000000000000000000000000000000",
      resolver:
        hierarchy.resolver?.address ||
        "0x0000000000000000000000000000000000000000",
      level,
    });

    return {
      name,
      hierarchy: levels.reverse(), // Root first
    };
  }

  // Build hierarchy response from blockchain data
  private buildHierarchyResponseFromBlockchain(
    hierarchy: BlockchainNameData,
    name: string,
  ): RegistryHierarchyResponse {
    // The FallbackService returns a hierarchy object with parent chain
    const levels: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    const level = this.getDomainLevel(name);

    // Just add the current domain for now
    levels.push({
      name: hierarchy.name,
      owner:
        hierarchy.owner?.id || "0x0000000000000000000000000000000000000000",
      resolver:
        hierarchy.resolver?.address ||
        "0x0000000000000000000000000000000000000000",
      level,
    });

    return {
      name,
      hierarchy: levels.reverse(), // Root first
    };
  }

  // Generate basic hierarchy as fallback
  private generateBasicHierarchy(name: string): RegistryHierarchyResponse {
    const parts = name.split(".");
    const hierarchy: Array<{
      name: string;
      owner: string;
      resolver: string;
      level: number;
    }> = [];

    for (let i = parts.length - 1; i >= 0; i--) {
      const domainName = parts.slice(i).join(".");
      hierarchy.push({
        name: domainName,
        owner: "0x0000000000000000000000000000000000000000",
        resolver: CONTRACTS[this.network]?.resolver
          ?? "0x0000000000000000000000000000000000000000",
        level: parts.length - i,
      });
    }

    return { name, hierarchy };
  }

  // Build attributes array (v1-compatible format with display_type and epoch ms dates)
  private buildAttributes(
    domain: IndexerDomain,
    v2MigrationStatus: MigrationStatus,
  ): MetadataAttribute[] {
    const label = getLabel(domain.name);
    const attributes: MetadataAttribute[] = [];

    // Created Date (epoch ms)
    if (domain.createdAt) {
      const createdMs = this.toEpochMs(domain.createdAt);
      if (createdMs) {
        attributes.push({ trait_type: "Created Date", display_type: "date", value: createdMs });
      }
    }

    // Registration Date (same as created for ensnode data)
    if (domain.createdAt) {
      const registrationMs = this.toEpochMs(domain.createdAt);
      if (registrationMs) {
        attributes.push({ trait_type: "Registration Date", display_type: "date", value: registrationMs });
      }
    }

    // Expiration Date (epoch ms)
    if (domain.expiryDate) {
      const expiryMs = this.toEpochMs(domain.expiryDate);
      if (expiryMs) {
        attributes.push({ trait_type: "Expiration Date", display_type: "date", value: expiryMs });
      }
    }

    // Length (string code unit length of label)
    attributes.push({ trait_type: "Length", display_type: "number", value: label.length });

    // Segment Length (grapheme cluster count)
    attributes.push({ trait_type: "Segment Length", display_type: "number", value: getSegmentLength(domain.name) });

    // Character Set
    attributes.push({ trait_type: "Character Set", display_type: "string", value: getCharacterSet(domain.name) });

    // ENS v2 Migration Status
    attributes.push({ trait_type: "Migration Status", display_type: "string", value: v2MigrationStatus });

    return attributes;
  }

  // Build attributes from blockchain data (v1-compatible)
  private buildAttributesFromBlockchain(nameData: BlockchainNameData): MetadataAttribute[] {
    const label = getLabel(nameData.name);
    const attributes: MetadataAttribute[] = [
      { trait_type: "Length", display_type: "number", value: label.length },
      { trait_type: "Segment Length", display_type: "number", value: getSegmentLength(nameData.name) },
      { trait_type: "Character Set", display_type: "string", value: getCharacterSet(nameData.name) },
    ];

    return attributes;
  }

  // Build attributes from D1 record (v1-compatible)
  private buildAttributesFromD1Record(record: D1RecordData): MetadataAttribute[] {
    const label = getLabel(record.name);
    const attributes: MetadataAttribute[] = [];

    if (record.created_at) {
      const createdMs = new Date(record.created_at).getTime();
      if (!isNaN(createdMs)) {
        attributes.push({ trait_type: "Created Date", display_type: "date", value: createdMs });
        attributes.push({ trait_type: "Registration Date", display_type: "date", value: createdMs });
      }
    }

    if (record.expiry_date || record.expiryDate) {
      const expiryStr = record.expiry_date || record.expiryDate;
      const expiryMs = this.toEpochMs(expiryStr!);
      if (expiryMs) {
        attributes.push({ trait_type: "Expiration Date", display_type: "date", value: expiryMs });
      }
    }

    attributes.push({ trait_type: "Length", display_type: "number", value: label.length });
    attributes.push({ trait_type: "Segment Length", display_type: "number", value: getSegmentLength(record.name) });
    attributes.push({ trait_type: "Character Set", display_type: "string", value: getCharacterSet(record.name) });

    return attributes;
  }

  // Generate description text (v1-compatible)
  private generateDescription(name: string): string {
    return `${name}, an ENS name.`;
  }

  // Fallback base URL when request origin is not available
  private getDefaultBaseUrl(): string {
    return "https://metadata.ens.domains";
  }

  // Convert a timestamp string (Unix seconds or ISO) to epoch milliseconds
  private toEpochMs(value: string): number | null {
    // Try as Unix timestamp in seconds (all-digit string)
    if (/^\d+$/.test(value)) {
      const seconds = parseInt(value, 10);
      return seconds * 1000;
    }
    // Try as ISO string or other Date-parseable format
    const ms = new Date(value).getTime();
    return isNaN(ms) ? null : ms;
  }

  // Get domain level
  private getDomainLevel(name: string): number {
    return name.split(".").length;
  }

  // Get migration status from blockchain when ensnode is down
  private async getMigrationStatusFromBlockchain(
    name: string,
  ): Promise<MigrationStatusResponse> {
    try {
      const nameData = await this.resolver.resolveName(
        name,
        namehash(name),
        this.network,
      );

      // Determine migration status based on v1 vs v2 registry check
      const status: MigrationStatus = nameData.migrationStatus || MIGRATION_STATUS.UNMIGRATED;

      return {
        name,
        status,
        l1Owner:
          nameData.network === "mainnet" ? nameData.resolver.owner : undefined,
        expirationDate: nameData.expirationDate?.toISOString(),
      };
    } catch (error) {
      console.error("Blockchain migration status resolution failed:", error);
      throw new Error(
        `Unable to determine migration status for ${name} from blockchain`,
      );
    }
  }

  // Get registry hierarchy from blockchain when ensnode is down
  private async getHierarchyFromBlockchain(
    name: string,
  ): Promise<RegistryHierarchyResponse> {
    try {
      const parts = name.split(".");
      const hierarchy: Array<{
        name: string;
        owner: string;
        resolver: string;
        level: number;
      }> = [];

      // Build hierarchy by checking each level
      for (let i = parts.length - 1; i >= 0; i--) {
        const domainName = parts.slice(i).join(".");
        const level = parts.length - i;

        try {
          const nameData = await this.resolver.resolveName(
            domainName,
            namehash(domainName),
            this.network,
          );

          hierarchy.push({
            name: domainName,
            owner:
              nameData.resolver.owner ||
              "0x0000000000000000000000000000000000000000",
            resolver:
              nameData.resolver.resolver ||
              CONTRACTS[this.network]?.resolver || '',
            level,
          });
        } catch {
          // If we can't resolve a level, fill with defaults
          hierarchy.push({
            name: domainName,
            owner: "0x0000000000000000000000000000000000000000",
            resolver: CONTRACTS[this.network]?.resolver || '',
            level,
          });
        }
      }

      return {
        name,
        hierarchy: hierarchy.reverse(), // Root first
      };
    } catch (error) {
      console.error("Blockchain hierarchy resolution failed:", error);
      throw new Error(
        `Unable to resolve hierarchy for ${name} from blockchain`,
      );
    }
  }

  // Health check for all services
  async healthCheck() {
    const [ensnodeHealth, blockchainHealth, fallbackStatus, d1Health] =
      await Promise.all([
        this.ensnode.healthCheck().catch(() => ({ primary: false })),
        this.blockchain
          .healthCheck()
          .catch(() => ({
            mainnet: { primary: false },
            sepolia: { primary: false },
          })),
        Promise.resolve(this.fallback.getStatus()),
        this.d1
          ?.healthCheck()
          .catch(() => ({ connected: false, recordCount: 0 })),
      ]);

    // Flag ENSNode as degraded if reachable but slow (>1000ms for a trivial query)
    const ensnodeLatency = 'latency' in ensnodeHealth ? (ensnodeHealth as any).latency?.primary : undefined;
    const ensnodeStatus = ensnodeHealth.primary
      ? (ensnodeLatency && ensnodeLatency > 1000 ? "degraded" : "ok")
      : "fallback" in ensnodeHealth && ensnodeHealth.fallback
        ? "degraded"
        : "error";

    return {
      ensnode: ensnodeStatus,
      ensnodeLatency: ensnodeLatency ?? null,
      blockchain: {
        mainnet: blockchainHealth.mainnet.primary ? "ok" : "error",
        sepolia: blockchainHealth.sepolia.primary ? "ok" : "error",
      },
      fallback: {
        ensnodeHealthy: fallbackStatus.ensnode.healthy,
        blockchainEnabled: fallbackStatus.blockchain.enabled,
        lastEnsnodeCheck: new Date(
          fallbackStatus.ensnode.lastCheck,
        ).toISOString(),
        maxRetries: fallbackStatus.config.maxRetries,
        retryDelay: fallbackStatus.config.retryDelayMs,
        exponentialBackoff: fallbackStatus.config.exponentialBackoff,
      },
      d1: d1Health
        ? {
            connected: d1Health.connected,
            recordCount: d1Health.recordCount,
            enabled: this.d1 !== undefined,
          }
        : {
            connected: false,
            recordCount: 0,
            enabled: false,
          },
    };
  }

  // Reset fallback service health status
  resetFallbackHealth() {
    this.fallback.resetHealthStatus();
  }

  // Sync operations (if D1 is enabled)
  async syncDomain(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.syncDomain(name, force);
  }

  async syncDomainsBatch(names: string[], force: boolean = false) {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.syncDomainsBatch(names, force);
  }

  async syncMigrationStatus(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.syncMigrationStatus(name, force);
  }

  async syncHierarchy(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.syncHierarchy(name, force);
  }

  async syncDomainComplete(name: string, force: boolean = false) {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.syncDomainComplete(name, force);
  }

  async syncStaleRecords() {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.syncStaleRecords();
  }

  async getSyncStats() {
    if (!this.sync) {
      throw new Error("D1 sync is not enabled");
    }
    return await this.sync.getSyncStats();
  }

  // D1 cleanup
  async cleanupD1(maxAge?: number) {
    if (!this.d1) {
      throw new Error("D1 is not enabled");
    }
    return await this.d1.cleanup(maxAge);
  }

  // Check if D1 is enabled
  get d1Enabled(): boolean {
    return this.d1 !== undefined;
  }

  // Check if sync is enabled
  get syncEnabled(): boolean {
    return this.sync !== undefined;
  }

}
