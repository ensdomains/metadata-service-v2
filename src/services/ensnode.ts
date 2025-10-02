import { GraphQLClient } from "graphql-request";
import type { MigrationStatus } from "../types";
import { namehash } from "../utils/ens";

// GraphQL query fragments
const DOMAIN_FRAGMENT = `
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

// GraphQL queries
const GET_DOMAIN_QUERY = `
  query GetDomain($name: String!) {
    domain(id: $name) {
      ...DomainInfo
    }
  }
  ${DOMAIN_FRAGMENT}
`;

const GET_DOMAINS_QUERY = `
  query GetDomains($ids: [String!]!) {
    domains(where: { id_in: $ids }) {
      ...DomainInfo
    }
  }
  ${DOMAIN_FRAGMENT}
`;

const GET_MIGRATION_STATUS_QUERY = `
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

const GET_HIERARCHY_QUERY = `
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
  expiryDate?: string;
  createdAt?: string;
  ttl?: number;
  isMigrated?: boolean;
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

export class EnsnodeService {
  private client: GraphQLClient;
  private fallbackClient?: GraphQLClient;

  constructor(
    private config: {
      primaryEndpoint: string;
      fallbackEndpoint?: string;
      timeout?: number;
    },
  ) {
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

  // Execute query with automatic fallback
  private async executeQuery<T>(
    query: string,
    variables?: Record<string, any>,
  ): Promise<{ data: T; usedFallback: boolean }> {
    try {
      const data = await this.client.request<T>(query, variables);
      return { data, usedFallback: false };
    } catch (error) {
      console.warn("Primary ensnode endpoint failed:", error);

      if (this.fallbackClient) {
        try {
          const data = await this.fallbackClient.request<T>(query, variables);
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
    const nameHash = namehash(name.toLowerCase());
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeDomain | null;
    }>(GET_DOMAIN_QUERY, { name: nameHash });

    return { domain: data.domain, usedFallback };
  }

  // Get multiple domains in batch
  async getDomains(
    names: string[],
  ): Promise<{ domains: EnsnodeDomain[]; usedFallback: boolean }> {
    const nameHashes = names.map((name) => namehash(name.toLowerCase()));
    const { data, usedFallback } = await this.executeQuery<{
      domains: EnsnodeDomain[];
    }>(GET_DOMAINS_QUERY, { ids: nameHashes });

    return { domains: data.domains, usedFallback };
  }

  // Get migration status
  async getMigrationStatus(
    name: string,
  ): Promise<{ status: EnsnodeMigrationStatus | null; usedFallback: boolean }> {
    const nameHash = namehash(name.toLowerCase());
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeMigrationStatus | null;
    }>(GET_MIGRATION_STATUS_QUERY, { id: nameHash });

    return { status: data.domain, usedFallback };
  }

  // Get domain hierarchy
  async getHierarchy(name: string): Promise<{
    hierarchy: EnsnodeHierarchyItem | null;
    usedFallback: boolean;
  }> {
    const nameHash = namehash(name.toLowerCase());
    const { data, usedFallback } = await this.executeQuery<{
      domain: EnsnodeHierarchyItem | null;
    }>(GET_HIERARCHY_QUERY, { id: nameHash });

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

    // Test primary endpoint
    try {
      const start = Date.now();
      await this.client.request(`
        query HealthCheck {
          domains(first: 1) {
            id
          }
        }
      `);
      results.primary = true;
      results.latency.primary = Date.now() - start;
    } catch (error) {
      console.warn("Primary ensnode health check failed:", error);
    }

    // Test fallback endpoint if available
    if (this.fallbackClient) {
      try {
        const start = Date.now();
        await this.fallbackClient.request(`
          query HealthCheck {
            domains(first: 1) {
              id
            }
          }
        `);
        results.fallback = true;
        results.latency.fallback = Date.now() - start;
      } catch (error) {
        console.warn("Fallback ensnode health check failed:", error);
        results.fallback = false;
      }
    }

    return results;
  }

  // Use blockchain.isUnmigratedName() and blockchain.isEjectedName()
  static convertMigrationStatus(
    ensnode: EnsnodeMigrationStatus,
  ): MigrationStatus {
    // This method is deprecated and should not be used for ENS v2 migration status
    // ensnode's isMigrated field refers to the 2019 migration, not current L2 migration
    console.warn(
      "convertMigrationStatus is deprecated - use blockchain service to check actual migration status",
    );
    return "unmigrated"; // Conservative default
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
  static getCacheTTL(domain?: EnsnodeDomain): number {
    if (!domain) {
      return 300; // 5 minutes for non-existent domains
    }

    if (domain.isMigrated) {
      return 3600; // 1 hour for migrated domains (stable)
    }

    return 300; // 5 minutes for unmigrated domains (may change)
  }
}
