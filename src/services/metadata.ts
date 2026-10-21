// Metadata service that integrates indexerV2, internal KV cache, and blockchain fallback
import { IndexerService, type IndexerDomain } from "./indexer";
import { CacheService, CacheKeys, CacheTTL } from "./cache";
import { BlockchainService } from "./blockchain";
import { ResolverService } from "./resolver";
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from "./fallback";
import { SharedBreakerState } from "./breaker-state";
import { D1Service } from "./d1";
import { SyncService, DEFAULT_SYNC_CONFIG } from "./sync";
import { ExpiryVerdictCache, expiryVerdictKey } from "./expiry-verdict-cache";
import type {
  MetadataResponse,
  MetadataAttribute,
  MigrationStatusResponse,
  RegistryHierarchyResponse,
  BatchMetadataResponse,
} from "../types/api";
import { MIGRATION_STATUS, type NetworkName, type MigrationStatus, isMigrationStatus } from "../types";
import { classifyMigrationStatus, classifyV2IndexerRecord, isOnV2 } from "../utils/migration";
import { NotFoundError, UpstreamError, InvalidNameError, InvalidTokenIdError } from "./errors";
import {
  validateEnsName,
  isResolvableEnsName,
  getLabel,
  labelhash,
  canonicalizeName,
  getCharacterSet,
  getSegmentLength,
  isNormalized,
} from "../utils/ens";
import { CONTRACTS } from "./blockchain";
import { NETWORKS } from "../config/networks";

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
  /** On-chain classification from the v2-aware fallback tier
   *  (`unmigrated` | `migrated`; the chain can never prove `native`). */
  chainMigrationStatus?: string;
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
  /** bigname API for this network; it serves ENSv1 and ENSv2 names. */
  indexerV2Endpoint: string;
  fallbackToBlockchain: boolean;
  internalCacheEnabled: boolean; // KV cache for internal optimizations
  d1Enabled: boolean;
  /** D1 rows older than this are a miss on read (default D1_READ_MAX_AGE_MS). */
  d1ReadMaxAgeMs?: number;
  network?: NetworkName;
}

// A name the v2 ETHRegistry holds: a single label directly under eth.
function isEthRegistryName(name: string): boolean {
  return /^[^.]+\.eth$/.test(name);
}

export class MetadataService {
  private network: NetworkName;
  public indexerV2: IndexerService;
  private internalCache?: CacheService; // For internal optimizations only
  private cache: CacheService; // Backwards compatibility
  public blockchain: BlockchainService;
  private resolver: ResolverService;
  private fallback: FallbackService;
  private d1?: D1Service;
  private sync?: SyncService;
  // Live checkExpiry verdicts for this network, so the per-request expiry gate
  // reads the chain once per live name per TTL (see expiry-verdict-cache.ts).
  private expiryVerdicts = new ExpiryVerdictCache();

  constructor(
    config: MetadataServiceConfig,
    kv: KVNamespace,
    blockchainEnv: BlockchainEnvironment,
    db?: D1Database,
  ) {
    this.network = config.network || 'mainnet';
    this.indexerV2 = new IndexerService({
      endpoint: config.indexerV2Endpoint,
      chainId: NETWORKS[this.network].chain.id,
    });

    // Initialize internal cache for indexerV2 responses if enabled
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
      this.indexerV2,
      this.blockchain,
      this.resolver,
      // The indexer breaker's trips are shared with the other isolates through
      // KV, per network (each network has its own indexer).
      new SharedBreakerState(kv, `breaker:indexerV2:${this.network}`, fallbackConfig.indexerV2.healthCheckIntervalMs),
    );

    // Initialize D1 and sync services if enabled
    if (config.d1Enabled && db) {
      this.d1 = new D1Service(db, this.network, { readMaxAgeMs: config.d1ReadMaxAgeMs });
      this.sync = new SyncService(this.d1, this.indexerV2, DEFAULT_SYNC_CONFIG);
    }
  }

  // Get metadata for a single domain (no API response caching - CF handles this).
  // `executionCtx` (the request's) runs the D1 sync after the response.
  async getMetadata(
    network: NetworkName,
    registryType: "registry" | "namewrapper",
    identifier: string,
    baseUrl?: string,
    executionCtx?: Pick<ExecutionContext, 'waitUntil'>,
  ): Promise<MetadataResponse> {
    // Validate identifier as ENS name
    if (!isResolvableEnsName(identifier)) {
      throw new InvalidNameError();
    }

    try {
      // Use comprehensive fallback service (internally cached)
      const {
        data: domain,
        source,
        usedFallback,
      } = await this.fallback.getDomainMetadata(identifier);

      // Check if domain is expired.
      const expiryRaw = domain.expiryDate;
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

      if (source === "indexerV2") {
        metadata = await this.buildMetadataFromIndexer(
          domain as IndexerDomain,
          network,
          baseUrl,
          registryType,
        );

        // Store in D1 if enabled, off the response path: the sync (its D1 reads
        // and writes, and its migration/hierarchy follow-ups) runs under
        // waitUntil and stores the domain fetched above instead of querying
        // the indexer for it again. Without an execution context the sync
        // still runs, just not registered with the runtime.
        if (this.sync) {
          const sync = this.sync
            .syncDomain(identifier, false, domain as IndexerDomain)
            .catch((error) =>
              console.warn(`Failed to sync ${identifier} to D1:`, error),
            );
          executionCtx?.waitUntil(sync);
        }
      } else {
        // Built from blockchain data
        metadata = await this.buildMetadataFromBlockchain(
          domain as unknown as BlockchainNameData,
          network,
          baseUrl,
          registryType,
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
      // Try D1 as last resort if available. Not for a definitive NotFoundError:
      // every live source, the primary index included, agreed the name does not
      // exist, and a stale row must not overturn that (→ 404, and the metadata
      // cache evicts). D1 stays the rescue for outages, and for a miss while the
      // primary index was skipped (circuit breaker open).
      if (this.d1 && !(error instanceof NotFoundError && error.definitive)) {
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
              registryType,
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

  // Check if a .eth 2LD is expired. 410 is a cacheable, destructive verdict, so
  // this errs on the side of serving:
  //  - v2 is authoritative where deployed: a name can be live on v2 with a future
  //    expiry while its old v1 registration has lapsed (e.g. fox.eth on sepolia is
  //    REGISTERED on v2 until 2028 but expired on the v1 registrar in Feb 2026).
  //    Only fall back to the v1 registrar expiry when the name is provably NOT
  //    REGISTERED on v2 (AVAILABLE/RESERVED — both v1-authoritative).
  //  - FAIL OPEN when the v2 registry cannot be read (UpstreamError): "v2 state
  //    unknown + v1 lapsed" must not 410 a name that may be live on v2. (This is
  //    different from v2-not-deployed → getV2Registration returns null → the v1
  //    registrar is genuinely authoritative.)
  //  - Every request runs this gate, so a live verdict read from the chain is
  //    cached in-isolate (expiry-verdict-cache.ts). An expired verdict never is
  //    (a renewal can undo it at any moment), and neither is a fail-open outcome.
  async checkExpiry(name: string): Promise<void> {
    // ENS names are case-insensitive but labelhash is not: canonicalize before
    // the suffix check and any hashing, so `DeadName.ETH` gets the same verdict
    // as `deadname.eth` (a raw-case labelhash reads a nonexistent registrar
    // token → expiry 0 → the 410 gate would be silently bypassed).
    const canonical = canonicalizeName(name);
    if (!canonical.endsWith('.eth') || canonical.split('.').length !== 2) return;

    const verdictKey = expiryVerdictKey(canonical);
    if (this.expiryVerdicts.isLive(verdictKey)) return;

    // The fail-open returns below cache nothing; settleExpiry caches a live verdict.
    if (this.blockchain.isV2Configured(this.network)) {
      let v2: { status: number; expiry: bigint } | null;
      try {
        v2 = await this.blockchain.getV2Registration(this.network, canonical);
      } catch (error) {
        console.warn(`[expiry] v2 registration unreadable for ${canonical} — failing open (no 410):`, error);
        return;
      }
      if (v2 && v2.status === 2) {
        this.settleExpiry(canonical, verdictKey, v2.expiry);
        return; // live on v2 — ignore any lapsed v1 registration
      }
    }

    let expiry: bigint;
    try {
      const label = canonical.split('.')[0];
      const hash = labelhash(label);
      expiry = await this.blockchain.getExpiry(this.network, hash);
    } catch (error) {
      console.warn(`Failed to check expiry for ${canonical}:`, error);
      return;
    }
    this.settleExpiry(canonical, verdictKey, expiry);
  }

  // Throws DomainExpiredError (→ 410) if an expiry read from the chain (unix
  // seconds; 0 when there is none) has passed, and caches the live verdict
  // otherwise.
  private settleExpiry(canonical: string, verdictKey: string, expiry: bigint): void {
    const expiryMs = Number(expiry) * 1000;
    if (expiry && expiryMs < Date.now()) {
      throw new DomainExpiredError(canonical, new Date(expiryMs));
    }
    this.expiryVerdicts.setLive(verdictKey, expiry ? expiryMs : null);
  }

  /** Drops this isolate's cached expiry verdict for a changed name, given by
   *  whichever of the name and its namehash a webhook event carries, so the
   *  next request re-reads the chain. */
  evictExpiryVerdict({ name, namehash }: { name?: string | null; namehash?: unknown }): void {
    if (name) this.expiryVerdicts.delete(expiryVerdictKey(canonicalizeName(name)));
    if (typeof namehash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(namehash)) {
      this.expiryVerdicts.delete(namehash.toLowerCase());
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
  async resolveStatusForImage(
    network: NetworkName,
    name: string,
    opts?: { strict?: boolean },
  ): Promise<MigrationStatus> {
    if (!isResolvableEnsName(name)) {
      throw new InvalidNameError();
    }
    // Throws NotFoundError when nothing can resolve the name.
    const { data, source } = await this.fallback.getDomainMetadata(name);
    return this.statusFromSource(source, network, name, data, opts?.strict);
  }

  // Resolve contract address + tokenId to ENS name. Recognizes the v1
  // BaseRegistrar (tokenId = labelhash), the v1 NameWrapper (tokenId = namehash),
  // and — where v2 is deployed — every v2 registry (ERC1155; tokenId = labelhash
  // with the low 32 bits replaced by the token version): the ETHRegistry, and
  // any other registry the indexer knows (see resolveV2RegistryToken).
  async resolveTokenId(
    network: NetworkName,
    contractAddress: string,
    tokenId: string,
  ): Promise<{ name: string; registryType: 'registry' | 'namewrapper' }> {
    // A uint256 token id, in decimal or 0x/0X-prefixed hex. Anything else,
    // including values of 2^256 or more, is a client error, rejected before it
    // reaches BigInt()/pad() or an indexer query. (BigInt is safe once the
    // format check has passed.)
    if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n) {
      throw new InvalidTokenIdError();
    }
    // One canonical form (lowercase, 0x + 64 hex digits) for every contract
    // path, so the same uint256 resolves however it was written.
    const tokenHex = `0x${BigInt(tokenId).toString(16).padStart(64, '0')}` as `0x${string}`;

    const contracts = CONTRACTS[network];
    const addr = contractAddress.toLowerCase();

    if (addr === contracts.registrar.toLowerCase()) {
      // BaseRegistrar: the token id is the .eth name's labelhash.
      const { domain } = await this.indexerV2.getEthDomainByLabelhash(tokenHex);
      if (!domain) throw new NotFoundError(`No domain found for tokenId ${tokenId}`);
      return { name: domain.name, registryType: 'registry' };
    }
    if (addr === contracts.nameWrapper.toLowerCase()) {
      // NameWrapper: the token id is the node, and the wrapper keeps the name
      // of every node it has wrapped.
      const name = await this.blockchain.getWrappedName(network, tokenHex);
      if (!name) throw new NotFoundError(`No domain found for tokenId ${tokenId}`);
      return { name, registryType: 'namewrapper' };
    }
    if (await this.isV2RegistryAddress(network, addr)) {
      // v2 ETHRegistry (ERC1155). Marketplaces pass the native token id, a
      // labelhash whose low 32 bits are the token version, which only the
      // indexer can map back to a name. A token can only be a name directly
      // under eth.
      const { domain } = await this.indexerV2.getDomainByTokenId(tokenHex, addr);
      if (!domain?.name || !isEthRegistryName(domain.name)) {
        throw new NotFoundError(`No domain found for tokenId ${tokenId}`);
      }
      return { name: domain.name, registryType: 'registry' };
    }
    if (this.blockchain.isV2Configured(network)) {
      return this.resolveV2RegistryToken(addr, contractAddress, tokenHex, tokenId);
    }
    throw new NotFoundError(`Unknown contract address: ${contractAddress}`);
  }

  /**
   * A token of a v2 registry other than the ETHRegistry: the root registry, or
   * a user or wrapper registry under a name. Only the indexer knows these
   * registries, and only a lookup scoped to this one can name the token, since
   * the same id exists in every registry that has the label. `addr` is the
   * lowercase address.
   * - An address the indexer knows no registry at is a 404, as any other
   *   unknown contract (isRegistry caches the answer per isolate).
   * - A token is served under the registry's canonical name, never an alias,
   *   with the name read in the token's own lookup: a registry moved under
   *   another parent is named by where it is now (see
   *   IndexerService.getDomainByTokenId).
   * - A token the registry does not hold, or one that is unreachable (orphaned
   *   by a subregistry repoint, an unregistered label or an expired ancestor,
   *   so it has no name to serve), is a 404.
   * - The root registry's tokens are top-level names (eth, DNS TLDs), which
   *   this service has no metadata or card for: a 404.
   * - An indexer outage throws UpstreamError (a 503, not cached).
   */
  private async resolveV2RegistryToken(
    addr: string,
    contractAddress: string,
    tokenHex: `0x${string}`,
    tokenId: string,
  ): Promise<{ name: string; registryType: 'registry' }> {
    if (!(await this.indexerV2.isRegistry(addr))) {
      throw new NotFoundError(`Unknown contract address: ${contractAddress}`);
    }
    const { domain } = await this.indexerV2.getDomainByTokenId(tokenHex, addr);
    if (!domain?.name) {
      throw new NotFoundError(`No domain found for tokenId ${tokenId}`);
    }
    if (!domain.name.includes('.')) {
      throw new NotFoundError(`Top-level name ${domain.name} is not served`);
    }
    return { name: domain.name, registryType: 'registry' };
  }

  /** Whether `addr` (lowercase) is this network's v2 ETHRegistry — matches both
   *  the configured last-known address and the live one discovered via the UR
   *  anchor (they diverge when the v2 stack is redeployed). */
  private async isV2RegistryAddress(network: NetworkName, addr: string): Promise<boolean> {
    const configured = NETWORKS[network].v2.ethRegistry;
    if (configured.startsWith('0x') && addr === configured.toLowerCase()) return true;
    if (!this.blockchain.isV2Configured(network)) return false;
    try {
      const live = await this.blockchain.getV2Registries(network);
      return !!live && addr === live.eth.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * On-chain classification: the ETHRegistry status proves on-v2 vs not, but can
   * never prove `native` (that provenance lives only in the indexer). The
   * underlying check THROWS UpstreamError when the chain is unreadable — badge/
   * attribute callers catch and degrade to `unmigrated` explicitly (see below),
   * so an RPC outage is a logged decision rather than a silent coercion.
   */
  private async classifyOnChain(network: NetworkName, name: string): Promise<MigrationStatus> {
    const isUnmigrated = await this.blockchain.isUnmigratedName(network, name);
    return classifyMigrationStatus({ isUnmigrated, isOnV2: !isUnmigrated });
  }

  /**
   * Map a fallback-resolved record to a MigrationStatus, by source. Shared by
   * getMigrationStatus, metadata assembly, and the image path so they can't drift:
   *  - `indexerV2` (bigname) → classification from the row's protocol (an
   *    ENSv1 row is `unmigrated`: presence in the index alone does NOT mean
   *    on-v2);
   *  - `blockchain` → the on-chain classification computed by the v2-aware
   *    resolver (travels on `chainMigrationStatus`; never `native`).
   * Degrades to `unmigrated` (the safe legacy default) when the chain is
   * unreadable during corroboration — UNLESS `strict` is set: a degraded
   * default is acceptable for a rendered badge, but callers that PERSIST the
   * result (webhook → D1) must get the outage as an error instead, so a
   * transient failure can never durably overwrite a correct stored status.
   */
  private async statusFromSource(
    source: 'indexerV2' | 'blockchain',
    network: NetworkName,
    name: string,
    data: { isMigrated?: boolean; owner?: { id?: string }; ownerId?: string; protocol?: string; chainMigrationStatus?: string },
    strict = false,
  ): Promise<MigrationStatus> {
    if (source === 'indexerV2') {
      return classifyV2IndexerRecord(data);
    }
    if (isMigrationStatus(data.chainMigrationStatus)) {
      return data.chainMigrationStatus;
    }
    // A blockchain record missing its precomputed status needs the chain.
    try {
      return await this.classifyOnChain(network, name);
    } catch (error) {
      if (strict) {
        throw error instanceof UpstreamError
          ? error
          : new UpstreamError(`on-chain corroboration failed for ${name} on ${network}`, { cause: error });
      }
      console.warn(`[classify] on-chain corroboration failed for ${name} on ${network}, defaulting to unmigrated:`, error);
      return MIGRATION_STATUS.UNMIGRATED;
    }
  }

  // Get migration status (CF cache handles API response caching)
  async getMigrationStatus(name: string): Promise<MigrationStatusResponse> {
    if (!isResolvableEnsName(name)) {
      throw new InvalidNameError();
    }

    try {
      // Use comprehensive fallback service (internally cached)
      const {
        data: status,
        source,
        usedFallback,
      } = await this.fallback.getMigrationStatus(name);

      const migrationStatus = await this.statusFromSource(source, this.network, name, status);

      const response: MigrationStatusResponse = {
        name,
        status: migrationStatus,
        owner: status.owner?.id,
        expirationDate: status.expiryDate,
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
              name,
              status: d1Record.status,
              owner: d1Record.owner ?? undefined,
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

      // Preserve the fallback layer's taxonomy (NotFound → 404, Upstream → 503),
      // like resolveMetadata does: fabricating a 200 "unmigrated" here would let
      // an outage plant a wrong-but-cacheable answer at the edge and in clients.
      if (error instanceof NotFoundError || error instanceof UpstreamError) throw error;

      // Unexpected internal error (not an upstream verdict): legacy safe default.
      const fallbackResponse: MigrationStatusResponse = {
        name,
        status: MIGRATION_STATUS.UNMIGRATED,
      };

      return fallbackResponse;
    }
  }

  // Get registry hierarchy
  async getRegistryHierarchy(name: string): Promise<RegistryHierarchyResponse> {
    if (!isResolvableEnsName(name)) {
      throw new InvalidNameError();
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

      if (source === "indexerV2") {
        response = this.buildHierarchyResponse(hierarchy as any, name);
        // Cache with indexerV2 TTL for indexerV2 data
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
      // Try batch query from indexerV2
      const { domains } = await this.indexerV2.getDomains(validNames);

      // Build results
      const results = await Promise.allSettled(
        validNames.map(async (name) => {
          // Check expiry first
          await this.checkExpiry(name);

          const domain = domains.find((d) => d.name === name);

          if (domain) {
            // Also check indexerV2 expiryDate
            const expiryRaw = domain.expiryDate;
            if (expiryRaw) {
              const expiryMs = typeof expiryRaw === 'string' && expiryRaw.includes('T')
                ? new Date(expiryRaw).getTime()
                : parseInt(expiryRaw, 10) * 1000;
              if (expiryMs > 0 && expiryMs < Date.now()) {
                return { name, error: `${name} is expired` };
              }
            }

            const metadata = await this.buildMetadataFromIndexer(
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
          (r) => r.status === "rejected" || (r.status === "fulfilled" && "error" in r.value),
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
          (r) => r.status === "rejected" || (r.status === "fulfilled" && "error" in r.value),
        ).length,
      };
    }
  }

  /**
   * v1-parity `version` field (legacy metadata-service Version enum: v1=0,
   * v1w=1, v2=2): unwrapped v1 names → 0, NameWrapper names → 1, and names
   * living on ENS v2 (migrated/native) → 2.
   */
  private metadataVersion(
    registryType: 'registry' | 'namewrapper',
    status: MigrationStatus,
  ): number {
    if (isOnV2(status)) return 2;
    return registryType === 'namewrapper' ? 1 : 0;
  }

  /** Self-referencing URLs, honoring the registryType the client requested (a
   *  /namewrapper/... response must point at /namewrapper/... sub-resources). */
  private selfUrls(
    name: string,
    network: NetworkName,
    registryType: 'registry' | 'namewrapper',
    baseUrl?: string,
  ): { image: string; background: string } {
    const origin = baseUrl || this.getDefaultBaseUrl();
    const encoded = encodeURIComponent(name);
    return {
      image: `${origin}/${network}/${registryType}/${encoded}/image`,
      background: `${origin}/${network}/avatar/${encoded}`,
    };
  }

  // Build metadata response from indexer domain data. Classification is unified
  // through statusFromSource so metadata, /migration-status, and the image
  // badge can't drift.
  private async buildMetadataFromIndexer(
    domain: IndexerDomain,
    network: NetworkName,
    baseUrl: string | undefined,
    registryType: 'registry' | 'namewrapper' = 'registry',
  ): Promise<MetadataResponse> {
    const v2MigrationStatus = await this.statusFromSource('indexerV2', network, domain.name, domain);

    const urls = this.selfUrls(domain.name, network, registryType, baseUrl);

    return {
      is_normalized: isNormalized(domain.name),
      name: domain.name,
      description: this.generateDescription(domain.name),
      attributes: this.buildAttributes(domain, v2MigrationStatus),
      url: `https://app.ens.domains/name/${domain.name}`,
      last_request_date: Date.now(),
      version: this.metadataVersion(registryType, v2MigrationStatus),
      background_image: urls.background,
      image: urls.image,
      image_url: urls.image,
    };
  }

  // Build metadata response from blockchain data
  private async buildMetadataFromBlockchain(
    nameData: BlockchainNameData,
    network: NetworkName,
    baseUrl?: string,
    registryType: 'registry' | 'namewrapper' = 'registry',
  ): Promise<MetadataResponse> {
    // On-chain classification travels with the record (v2-aware resolver;
    // `unmigrated` | `migrated`, never `native`).
    const status: MigrationStatus = isMigrationStatus(nameData.chainMigrationStatus)
      ? nameData.chainMigrationStatus
      : MIGRATION_STATUS.UNMIGRATED;

    // Use the request's network for self-URLs — the blockchain fallback record
    // doesn't carry one (nameData.network was undefined → `/undefined/` URLs).
    const urls = this.selfUrls(nameData.name, network, registryType, baseUrl);

    return {
      is_normalized: isNormalized(nameData.name),
      name: nameData.name,
      description: this.generateDescription(nameData.name),
      attributes: this.buildAttributesFromBlockchain(nameData, status),
      url: `https://app.ens.domains/name/${nameData.name}`,
      last_request_date: Date.now(),
      version: this.metadataVersion(registryType, status),
      background_image: urls.background,
      image: urls.image,
      image_url: urls.image,
    };
  }

  // Build metadata response from D1 record
  private async buildMetadataFromD1Record(
    record: D1RecordData,
    network: NetworkName,
    baseUrl?: string,
    registryType: 'registry' | 'namewrapper' = 'registry',
  ): Promise<MetadataResponse> {
    // Best-effort migration status from the D1 migration_status table (written by
    // sync + the webhook). D1 is the last-resort tier — absence just omits the
    // attribute rather than asserting a possibly-wrong `unmigrated`.
    let status: MigrationStatus | undefined;
    if (this.d1) {
      try {
        const row = await this.d1.getMigrationStatus(record.name);
        if (row && isMigrationStatus(row.status)) status = row.status;
      } catch (error) {
        console.warn(`[d1] migration status lookup failed for ${record.name}:`, error);
      }
    }

    const urls = this.selfUrls(record.name, network, registryType, baseUrl);

    return {
      is_normalized: isNormalized(record.name),
      name: record.name,
      description: this.generateDescription(record.name),
      attributes: this.buildAttributesFromD1Record(record, status),
      url: `https://app.ens.domains/name/${record.name}`,
      last_request_date: Date.now(),
      version: this.metadataVersion(registryType, status ?? MIGRATION_STATUS.UNMIGRATED),
      background_image: urls.background,
      image: urls.image,
      image_url: urls.image,
    };
  }

  // Build hierarchy response from indexerV2 data
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

    // Registration Date (same as created for indexerV2 data)
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

  // Build attributes from blockchain data (v1-compatible). Includes the same
  // 'Migration Status' trait as the indexer path so the attribute set doesn't
  // silently change shape when a request is served from the fallback tier.
  private buildAttributesFromBlockchain(
    nameData: BlockchainNameData,
    migrationStatus: MigrationStatus,
  ): MetadataAttribute[] {
    const label = getLabel(nameData.name);
    const attributes: MetadataAttribute[] = [
      { trait_type: "Length", display_type: "number", value: label.length },
      { trait_type: "Segment Length", display_type: "number", value: getSegmentLength(nameData.name) },
      { trait_type: "Character Set", display_type: "string", value: getCharacterSet(nameData.name) },
      { trait_type: "Migration Status", display_type: "string", value: migrationStatus },
    ];

    return attributes;
  }

  // Build attributes from D1 record (v1-compatible). `migrationStatus` is the
  // best-effort value from the D1 migration_status table; omitted when unknown.
  private buildAttributesFromD1Record(
    record: D1RecordData,
    migrationStatus?: MigrationStatus,
  ): MetadataAttribute[] {
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
    if (migrationStatus) {
      attributes.push({ trait_type: "Migration Status", display_type: "string", value: migrationStatus });
    }

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

  /**
   * Persist a freshly-classified migration status to D1 (the last-resort tier).
   * Called by the webhook path after a name-change event so D1 reflects the
   * newest known state instead of a stale (or hardcoded) value. No-op when D1
   * is disabled; never throws (best-effort persistence).
   */
  async recordMigrationStatus(name: string, status: MigrationStatus, data?: {
    owner?: string;
    expirationDate?: string;
  }): Promise<void> {
    if (!this.d1) return;
    try {
      await this.d1.storeMigrationStatus(name, status, data ?? {});
    } catch (error) {
      console.warn(`[d1] failed to record migration status for ${name}:`, error);
    }
  }

  // Health check for all services
  async healthCheck() {
    const [indexerV2Health, blockchainHealth, fallbackStatus, d1Health] =
      await Promise.all([
        this.indexerV2.healthCheck().catch(() => ({ primary: false })),
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

    // Flag the indexer as degraded if reachable but slow (>1000ms for its status)
    const indexerV2Latency = 'latency' in indexerV2Health ? indexerV2Health.latency?.primary : undefined;
    const indexerV2Status = indexerV2Health.primary
      ? (indexerV2Latency && indexerV2Latency > 1000 ? "degraded" : "ok")
      : "fallback" in indexerV2Health && indexerV2Health.fallback
        ? "degraded"
        : "error";

    return {
      indexerV2: indexerV2Status,
      indexerV2Latency: indexerV2Latency ?? null,
      blockchain: {
        mainnet: blockchainHealth.mainnet.primary ? "ok" : "error",
        sepolia: blockchainHealth.sepolia.primary ? "ok" : "error",
      },
      fallback: {
        indexerV2Healthy: fallbackStatus.indexerV2.healthy,
        blockchainEnabled: fallbackStatus.blockchain.enabled,
        lastIndexerV2Check: new Date(
          fallbackStatus.indexerV2.lastCheck,
        ).toISOString(),
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
    return this.fallback.resetHealthStatus();
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
