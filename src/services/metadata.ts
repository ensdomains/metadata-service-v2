// Metadata service that integrates ensnode, internal KV cache, and blockchain fallback
import { EnsnodeService, type EnsnodeDomain } from "./ensnode";
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
import type { NetworkName, MigrationStatus } from "../types";
import {
  validateEnsName,
  getLabel,
  namehash,
  getCharacterSet,
  getSegmentLength,
  isNormalized,
} from "../utils/ens";

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
  fallbackToBlockchain: boolean;
  internalCacheEnabled: boolean; // KV cache for internal optimizations
  d1Enabled: boolean;
}

export class MetadataService {
  private ensnode: EnsnodeService;
  private internalCache?: CacheService; // For internal optimizations only
  private cache: CacheService; // Backwards compatibility
  private blockchain: BlockchainService;
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
    this.ensnode = new EnsnodeService({
      primaryEndpoint: config.ensnodeEndpoint,
      fallbackEndpoint: config.ensnodeFallbackEndpoint,
    });

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
    this.fallback = new FallbackService(
      config.fallbackToBlockchain
        ? DEFAULT_FALLBACK_CONFIG
        : {
            ...DEFAULT_FALLBACK_CONFIG,
            blockchain: {
              ...DEFAULT_FALLBACK_CONFIG.blockchain,
              enabled: config.fallbackToBlockchain,
            },
          },
      this.ensnode,
      this.blockchain,
      this.resolver,
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

      let metadata: MetadataResponse;

      if (source === "ensnode") {
        metadata = await this.buildMetadataFromEnsnode(
          domain as EnsnodeDomain,
          network,
          baseUrl,
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
          baseUrl,
        );
      }

      if (usedFallback) {
        console.warn(`Fallback to ${source} used for ${identifier}`);
      }

      return metadata;
    } catch (error) {
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

      throw new Error(`Failed to resolve metadata for ${identifier}`);
    }
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

      if (source === "ensnode") {
        response = {
          name,
          status: EnsnodeService.convertMigrationStatus(status as any),
          l1Owner: (status as any).owner?.id,
          expirationDate: (status as any).expiryDate,
        };
      } else {
        // Built from blockchain data
        response = {
          name,
          status: (status as any).isMigrated ? "native" : "unmigrated",
          l1Owner: (status as any).owner?.id,
          expirationDate: (status as any).expiryDate,
        };
      }

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
        status: "unmigrated",
      };

      return fallbackResponse;
    }
  }

  // Get registry hierarchy
  async getRegistryHierarchy(name: string): Promise<RegistryHierarchyResponse> {
    if (!validateEnsName(name)) {
      throw new Error("Invalid ENS name format");
    }

    const cacheKey = CacheKeys.hierarchy(name);

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
          const domain = domains.find((d) => d.name === name);

          if (domain) {
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
            } catch {
              return { name, error: `Failed to resolve ${name}` };
            }
          }
        }),
      );

      // Process results
      const response: BatchMetadataResponse = {
        results: results.map((result) => {
          if (result.status === "fulfilled") {
            return result.value;
          } else {
            return { name: "", error: "Processing failed" };
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

  // Build metadata response from ensnode domain data
  private async buildMetadataFromEnsnode(
    domain: EnsnodeDomain,
    network: NetworkName,
    baseUrl?: string,
  ): Promise<MetadataResponse> {
    // NOTE: ensnode's isMigrated refers to 2019 permanent registrar migration, NOT ENS v2
    // We must verify on-chain ENS v2 migration status until it's being provided
    const isUnmigrated = await this.blockchain.isUnmigratedName(domain.name);

    let v2MigrationStatus: MigrationStatus;
    let isMigrated: boolean;

    if (isUnmigrated) {
      v2MigrationStatus = "unmigrated";
      isMigrated = false;
    } else {
      v2MigrationStatus = "native";
      isMigrated = true;
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
    baseUrl?: string,
  ): Promise<MetadataResponse> {
    const origin = baseUrl || this.getDefaultBaseUrl();
    const imageUrl = `${origin}/${nameData.network}/registry/${encodeURIComponent(nameData.name)}/image`;

    return {
      is_normalized: isNormalized(nameData.name),
      name: nameData.name,
      description: this.generateDescription(nameData.name),
      attributes: this.buildAttributesFromBlockchain(nameData),
      url: `https://app.ens.domains/name/${nameData.name}`,
      last_request_date: Date.now(),
      version: 0,
      background_image: `${origin}/${nameData.network}/avatar/${nameData.name}`,
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
    hierarchy: EnsnodeDomain,
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
        resolver: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
        level: parts.length - i,
      });
    }

    return { name, hierarchy };
  }

  // Build attributes array (v1-compatible format with display_type and epoch ms dates)
  private buildAttributes(
    domain: EnsnodeDomain,
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
        "mainnet",
      );

      // Determine migration status based on v1 vs v2 registry check
      const status: MigrationStatus = nameData.migrationStatus || "unmigrated";

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
            "mainnet",
          );

          hierarchy.push({
            name: domainName,
            owner:
              nameData.resolver.owner ||
              "0x0000000000000000000000000000000000000000",
            resolver:
              nameData.resolver.resolver ||
              "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
            level,
          });
        } catch {
          // If we can't resolve a level, fill with defaults
          hierarchy.push({
            name: domainName,
            owner: "0x0000000000000000000000000000000000000000",
            resolver: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
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

    return {
      ensnode: ensnodeHealth.primary
        ? "ok"
        : "fallback" in ensnodeHealth && ensnodeHealth.fallback
          ? "degraded"
          : "error",
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
