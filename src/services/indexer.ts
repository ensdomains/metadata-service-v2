import { GraphQLClient } from "graphql-request";
import { namehash } from "../utils/ens";
import { UpstreamError } from "./errors";

// ---- v1 subgraph queries (mainnet — id = namehash) ----

const V1_DOMAIN_FRAGMENT = `
  fragment DomainInfo on Domain {
    id
    name
    labelName
    labelhash
    parentId
    ownerId
    resolverId
    registrantId
    expiryDate
    createdAt
    ttl
    isMigrated
    owner {
      id
    }
    resolver {
      address
    }
    registrant {
      id
    }
  }
`;

const V1_GET_DOMAIN = `
  query GetDomain($name: String!) {
    domain(id: $name) {
      ...DomainInfo
    }
  }
  ${V1_DOMAIN_FRAGMENT}
`;

const V1_GET_DOMAINS = `
  query GetDomains($ids: [String!]!, $first: Int!) {
    domains(first: $first, where: { id_in: $ids }) {
      ...DomainInfo
    }
  }
  ${V1_DOMAIN_FRAGMENT}
`;

const V1_GET_MIGRATION_STATUS = `
  query GetMigrationStatus($id: String!) {
    domain(id: $id) {
      name
      isMigrated
      ownerId
      resolverId
      parentId
      expiryDate
      owner {
        id
      }
      resolver {
        address
      }
    }
  }
`;

const V1_GET_HIERARCHY = `
  query GetHierarchy($id: String!) {
    domain(id: $id) {
      name
      ownerId
      resolverId
      parentId
      owner {
        id
      }
      resolver {
        address
      }
      parent {
        name
        ownerId
        resolverId
        parentId
        owner {
          id
        }
        resolver {
          address
        }
        parent {
          name
          ownerId
          resolverId
          owner {
            id
          }
          resolver {
            address
          }
        }
      }
    }
  }
`;

// ---- v2 staging queries (sepolia — id = name string) ----

const V2_GET_DOMAIN = `
  query GetDomain($name: String!) {
    domain(id: $name) {
      id
      name
      labelName
      labelhash
      expiryDate
      createdAt
      ttl
      isMigrated
      protocol
      tokenId
      tokenVersion
      owner {
        id
      }
      resolver {
        address
      }
      registrant {
        id
      }
      parent {
        id
        name
      }
    }
  }
`;

const V2_GET_DOMAINS = `
  query GetDomains($names: [String!]!, $first: Int!) {
    domains(first: $first, where: { name_in: $names }) {
      id
      name
      labelName
      labelhash
      expiryDate
      createdAt
      ttl
      isMigrated
      protocol
      tokenId
      tokenVersion
      owner {
        id
      }
      resolver {
        address
      }
      registrant {
        id
      }
    }
  }
`;

const V2_GET_MIGRATION_STATUS = `
  query GetMigrationStatus($id: String!) {
    domain(id: $id) {
      name
      isMigrated
      protocol
      tokenVersion
      expiryDate
      owner {
        id
      }
      resolver {
        address
      }
    }
  }
`;

const V2_GET_HIERARCHY = `
  query GetHierarchy($id: String!) {
    domain(id: $id) {
      name
      owner {
        id
      }
      resolver {
        address
      }
      parent {
        name
        owner {
          id
        }
        resolver {
          address
        }
        parent {
          name
          owner {
            id
          }
          resolver {
            address
          }
        }
      }
    }
  }
`;

// Response types
export interface IndexerDomain {
  id: string;
  name: string;
  labelName: string;
  labelhash: string;
  parentId?: string;
  ownerId?: string;
  resolverId?: string;
  registrantId?: string;
  owner?: {
    id: string;
  };
  resolver?: {
    address: string;
  };
  registrant?: {
    id: string;
  };
  parent?: {
    id?: string;
    name?: string;
  };
  expiryDate?: string;
  createdAt?: string;
  ttl?: number;
  isMigrated?: boolean;
  tokenId?: string;
  tokenVersion?: number;
  /** zigens row provenance: "v1" = legacy ENS row, "v2" = ENSv2 row. The v2
   *  indexer can serve BOTH — classification must not equate presence with
   *  being on v2 (see utils/migration.ts classifyV2IndexerRecord). */
  protocol?: string;
  /** Set ONLY by the blockchain fallback tier (fallback.ts): the on-chain
   *  classification of the record (`unmigrated` | `migrated`; never `native`). */
  chainMigrationStatus?: string;
}

export interface IndexerResponse<T> {
  data: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

export interface IndexerMigrationStatus {
  name: string;
  isMigrated: boolean;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  expiryDate?: string;
  tokenVersion?: number;
  /** zigens row provenance ("v1" | "v2") — see IndexerDomain.protocol. */
  protocol?: string;
  /** Set ONLY by the blockchain fallback tier — see IndexerDomain.chainMigrationStatus. */
  chainMigrationStatus?: string;
}

export interface IndexerHierarchyItem {
  name: string;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  parent?: IndexerHierarchyItem;
}

type ApiVersion = 'v1' | 'v2';

export class IndexerService {
  private client: GraphQLClient;
  private fallbackClient?: GraphQLClient;
  private timeout: number;
  /** Query dialect: 'v1' = ENSNode subgraph (namehash ids), 'v2' = zigens (name-string ids). */
  readonly apiVersion: ApiVersion;

  constructor(
    private config: {
      primaryEndpoint: string;
      fallbackEndpoint?: string;
      timeout?: number;
      apiVersion?: ApiVersion;
    },
  ) {
    this.timeout = config.timeout || 2000;
    this.apiVersion = config.apiVersion || 'v1';
    console.log(`[indexer] initialized with endpoint: ${config.primaryEndpoint}, version: ${this.apiVersion}, timeout: ${this.timeout}ms`);
    this.client = new GraphQLClient(config.primaryEndpoint, {
      headers: {
        "User-Agent": "ENS-Metadata-V2/2.0.0",
      },
    });

    if (config.fallbackEndpoint) {
      this.fallbackClient = new GraphQLClient(config.fallbackEndpoint, {
        headers: {
          "User-Agent": "ENS-Metadata-V2/2.0.0",
        },
      });
    }
  }

  // Resolve domain ID: v1 uses namehash, v2 uses name string
  private resolveDomainId(name: string): string {
    if (this.apiVersion === 'v2') {
      return name.toLowerCase();
    }
    return namehash(name.toLowerCase());
  }

  // Execute a GraphQL query. A transport/timeout/GraphQL failure is retried once
  // on the primary (transient blips shouldn't trip the upstream circuit-breaker),
  // then the optional secondary endpoint is tried, and finally an UpstreamError is
  // thrown. A *successful* response with empty data is NOT an error — callers map
  // a null result to NotFoundError, which the fallback layer treats as a clean
  // miss rather than an upstream failure.
  private async executeQuery<T>(
    query: string,
    variables?: Record<string, any>,
  ): Promise<{ data: T; usedFallback: boolean }> {
    const request = (client: GraphQLClient) =>
      client.request<T>({ document: query, variables, signal: AbortSignal.timeout(this.timeout) });

    // Primary, with a single retry on transient failure.
    let primaryError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { data: await request(this.client), usedFallback: false };
      } catch (error) {
        primaryError = error;
        if (attempt === 0) console.warn(`[indexer] primary request failed (attempt ${attempt + 1}), retrying:`, error);
      }
    }
    console.warn("[indexer] primary endpoint failed after retry:", primaryError);

    if (this.fallbackClient) {
      try {
        return { data: await request(this.fallbackClient), usedFallback: true };
      } catch (fallbackError) {
        throw new UpstreamError(
          `All ensnode endpoints failed for query. Last error: ${fallbackError}`,
          { cause: fallbackError },
        );
      }
    }

    throw new UpstreamError(`ensnode request failed: ${primaryError}`, { cause: primaryError });
  }

  // Get single domain data
  async getDomain(
    name: string,
  ): Promise<{ domain: IndexerDomain | null; usedFallback: boolean }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_DOMAIN : V1_GET_DOMAIN;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerDomain | null;
    }>(query, { name: id });

    return { domain: data.domain, usedFallback };
  }

  // Get domain by pre-computed namehash (for tokenId lookups). Works on BOTH
  // dialects: the v1 subgraph keys domains by namehash, and zigens' domain(id:)
  // resolves "name or namehash" (verified live against graphql.ens.dev — a
  // namehash id returns the domain; raw labelhash / versioned-tokenId forms do NOT).
  async getDomainByNamehash(
    nameHash: string,
  ): Promise<{ domain: IndexerDomain | null; usedFallback: boolean }> {
    const query = this.apiVersion === 'v2' ? V2_GET_DOMAIN : V1_GET_DOMAIN;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerDomain | null;
    }>(query, { name: nameHash });

    return { domain: data.domain, usedFallback };
  }

  // Get multiple domains in batch
  async getDomains(
    names: string[],
  ): Promise<{ domains: IndexerDomain[]; usedFallback: boolean }> {
    if (this.apiVersion === 'v2') {
      const ids = names.map(n => n.toLowerCase());
      const { data, usedFallback } = await this.executeQuery<{
        domains: IndexerDomain[];
      }>(V2_GET_DOMAINS, { names: ids, first: ids.length });
      return { domains: data.domains, usedFallback };
    }

    const nameHashes = names.map((name) => namehash(name.toLowerCase()));
    const { data, usedFallback } = await this.executeQuery<{
      domains: IndexerDomain[];
    }>(V1_GET_DOMAINS, { ids: nameHashes, first: nameHashes.length });

    return { domains: data.domains, usedFallback };
  }

  // Get migration status
  async getMigrationStatus(
    name: string,
  ): Promise<{ status: IndexerMigrationStatus | null; usedFallback: boolean }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_MIGRATION_STATUS : V1_GET_MIGRATION_STATUS;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerMigrationStatus | null;
    }>(query, { id });

    return { status: data.domain, usedFallback };
  }

  // Get domain hierarchy
  async getHierarchy(name: string): Promise<{
    hierarchy: IndexerHierarchyItem | null;
    usedFallback: boolean;
  }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_HIERARCHY : V1_GET_HIERARCHY;
    const { data, usedFallback } = await this.executeQuery<{
      domain: IndexerHierarchyItem | null;
    }>(query, { id });

    return { hierarchy: data.domain, usedFallback };
  }

  // Health check
  async healthCheck(): Promise<{
    primary: boolean;
    fallback?: boolean;
    latency: { primary?: number; fallback?: number };
  }> {
    const results = {
      primary: false,
      fallback: undefined as boolean | undefined,
      latency: {} as { primary?: number; fallback?: number },
    };

    const healthQuery = `query HealthCheck { domains(first: 1) { id } }`;

    // Test primary endpoint
    try {
      const start = Date.now();
      await this.client.request({
        document: healthQuery,
        signal: AbortSignal.timeout(this.timeout),
      });
      results.primary = true;
      results.latency.primary = Date.now() - start;
    } catch (error) {
      console.warn("Primary ensnode health check failed:", error);
    }

    // Test fallback endpoint if available
    if (this.fallbackClient) {
      try {
        const start = Date.now();
        await this.fallbackClient.request({
          document: healthQuery,
          signal: AbortSignal.timeout(this.timeout),
        });
        results.fallback = true;
        results.latency.fallback = Date.now() - start;
      } catch (error) {
        console.warn("Fallback ensnode health check failed:", error);
        results.fallback = false;
      }
    }

    return results;
  }

  // Build cache key for ensnode responses
  static getCacheKey(operation: string, params: Record<string, any>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}:${params[key]}`)
      .join(",");

    return `ensnode:${operation}:${sortedParams}`;
  }

  // Get appropriate cache TTL based on migration status
  static getCacheTTL(_domain?: IndexerDomain): number {
    // isMigrated from v1 subgraph means 2019 registrar migration, not v2.
    // Use a uniform TTL until v2 migration status is reliable across all networks.
    return 300; // 5 minutes
  }
}
