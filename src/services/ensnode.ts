import { GraphQLClient } from "graphql-request";
import { namehash } from "../utils/ens";

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
  query GetDomains($ids: [String!]!) {
    domains(where: { id_in: $ids }) {
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
  query GetDomains($names: [String!]!) {
    domains(where: { name_in: $names }) {
      id
      name
      labelName
      labelhash
      expiryDate
      createdAt
      ttl
      isMigrated
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
export interface EnsnodeDomain {
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
}

export interface EnsnodeResponse<T> {
  data: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
  }>;
}

export interface EnsnodeMigrationStatus {
  name: string;
  isMigrated: boolean;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  expiryDate?: string;
  tokenVersion?: number;
}

export interface EnsnodeHierarchyItem {
  name: string;
  ownerId?: string;
  resolverId?: string;
  parentId?: string;
  owner?: { id: string };
  resolver?: { address: string };
  parent?: EnsnodeHierarchyItem;
}

type ApiVersion = 'v1' | 'v2';

export class EnsnodeService {
  private client: GraphQLClient;
  private fallbackClient?: GraphQLClient;
  private timeout: number;
  private apiVersion: ApiVersion;

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
    console.log(`[ensnode] initialized with endpoint: ${config.primaryEndpoint}, version: ${this.apiVersion}, timeout: ${this.timeout}ms`);
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

  // Execute query with automatic fallback
  private async executeQuery<T>(
    query: string,
    variables?: Record<string, any>,
  ): Promise<{ data: T; usedFallback: boolean }> {
    try {
      const data = await this.client.request<T>({
        document: query,
        variables,
        signal: AbortSignal.timeout(this.timeout),
      });
      return { data, usedFallback: false };
    } catch (error) {
      console.warn("Primary ensnode endpoint failed:", error);

      if (this.fallbackClient) {
        try {
          const data = await this.fallbackClient.request<T>({
            document: query,
            variables,
            signal: AbortSignal.timeout(this.timeout),
          });
          return { data, usedFallback: true };
        } catch (fallbackError) {
          console.error(
            "Fallback ensnode endpoint also failed:",
            fallbackError,
          );
          throw new Error(
            `All ensnode endpoints failed. Last error: ${fallbackError}`,
          );
        }
      }

      throw error;
    }
  }

  // Get single domain data
  async getDomain(
    name: string,
  ): Promise<{ domain: EnsnodeDomain | null; usedFallback: boolean }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_DOMAIN : V1_GET_DOMAIN;
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeDomain | null;
    }>(query, { name: id });

    return { domain: data.domain, usedFallback };
  }

  // Get domain by pre-computed namehash (for v1 tokenId lookups)
  async getDomainByNamehash(
    nameHash: string,
  ): Promise<{ domain: EnsnodeDomain | null; usedFallback: boolean }> {
    // v1: use namehash directly; v2: not applicable, pass through
    const query = this.apiVersion === 'v2' ? V2_GET_DOMAIN : V1_GET_DOMAIN;
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeDomain | null;
    }>(query, { name: nameHash });

    return { domain: data.domain, usedFallback };
  }

  // Get multiple domains in batch
  async getDomains(
    names: string[],
  ): Promise<{ domains: EnsnodeDomain[]; usedFallback: boolean }> {
    if (this.apiVersion === 'v2') {
      const ids = names.map(n => n.toLowerCase());
      const { data, usedFallback } = await this.executeQuery<{
        domains: EnsnodeDomain[];
      }>(V2_GET_DOMAINS, { names: ids });
      return { domains: data.domains, usedFallback };
    }

    const nameHashes = names.map((name) => namehash(name.toLowerCase()));
    const { data, usedFallback } = await this.executeQuery<{
      domains: EnsnodeDomain[];
    }>(V1_GET_DOMAINS, { ids: nameHashes });

    return { domains: data.domains, usedFallback };
  }

  // Get migration status
  async getMigrationStatus(
    name: string,
  ): Promise<{ status: EnsnodeMigrationStatus | null; usedFallback: boolean }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_MIGRATION_STATUS : V1_GET_MIGRATION_STATUS;
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeMigrationStatus | null;
    }>(query, { id });

    return { status: data.domain, usedFallback };
  }

  // Get domain hierarchy
  async getHierarchy(name: string): Promise<{
    hierarchy: EnsnodeHierarchyItem | null;
    usedFallback: boolean;
  }> {
    const id = this.resolveDomainId(name);
    const query = this.apiVersion === 'v2' ? V2_GET_HIERARCHY : V1_GET_HIERARCHY;
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeHierarchyItem | null;
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
  static getCacheTTL(_domain?: EnsnodeDomain): number {
    // isMigrated from v1 subgraph means 2019 registrar migration, not v2.
    // Use a uniform TTL until v2 migration status is reliable across all networks.
    return 300; // 5 minutes
  }
}
