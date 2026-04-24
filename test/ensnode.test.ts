import { describe, it, expect, vi, beforeEach } from "vitest";
import { EnsnodeService } from "../src/services/ensnode";
import { CacheService, CacheKeys } from "../src/services/cache";

// Mock data for testing
const mockDomainData = {
  "test.eth": {
    id: "0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658",
    name: "test.eth",
    labelName: "test",
    labelhash: "0x1234567890abcdef",
    ownerId: "0x1234567890123456789012345678901234567890",
    resolverId: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
    registrantId: "0x1234567890123456789012345678901234567890",
    owner: { id: "0x1234567890123456789012345678901234567890" },
    resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
    registrant: { id: "0x1234567890123456789012345678901234567890" },
    isMigrated: false,
    createdAt: "1640995200",
    expiryDate: "1735689600",
    parentId:
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
  },
  "migrated.eth": {
    id: "0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
    name: "migrated.eth",
    labelName: "migrated",
    labelhash:
      "0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
    ownerId: "0x9876543210987654321098765432109876543210",
    resolverId: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
    registrantId: "0x9876543210987654321098765432109876543210",
    owner: { id: "0x9876543210987654321098765432109876543210" },
    resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
    registrant: { id: "0x9876543210987654321098765432109876543210" },
    isMigrated: true,
    createdAt: "1640995200",
    expiryDate: "1735689600",
    parentId:
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
  },
};

// Mock the namehash function with enhanced data
vi.mock("../src/utils/ens", () => ({
  namehash: (name: string) => {
    if (name === "test.eth") {
      return mockDomainData["test.eth"].id;
    }
    if (name === "migrated.eth") {
      return mockDomainData["migrated.eth"].id;
    }
    if (name === "nonexistent.eth") {
      return "0x1111111111111111111111111111111111111111111111111111111111111111";
    }
    return "0x0000000000000000000000000000000000000000000000000000000000000000";
  },
  validateEnsName: (name: string) => {
    return (
      typeof name === "string" &&
      name.length > 0 &&
      !name.includes("..") &&
      name.endsWith(".eth")
    );
  },
}));

// Mock GraphQL client — the real code calls request({ document, variables, signal })
vi.mock("graphql-request", () => ({
  GraphQLClient: class {
    constructor(public endpoint: string) {}
    async request(options: { document: string; variables?: Record<string, unknown>; signal?: AbortSignal }) {
      await new Promise((resolve) => setTimeout(resolve, 1));

      const query = options.document;
      const variables = options.variables;

      // Health check query
      if (query.includes("domains(first: 1)")) {
        return { domains: [{ id: "test.eth" }] };
      }

      // Domain query by namehash
      if (variables?.name) {
        const domain = Object.values(mockDomainData).find(
          (d) => d.id === variables.name,
        );
        if (!domain) return { domain: null };
        return { domain };
      }

      // Migration status and hierarchy queries
      if (variables?.id) {
        const domain = Object.values(mockDomainData).find(
          (d) => d.id === variables.id,
        );
        if (!domain) return { domain: null };

        // Return appropriate response based on query type
        if (query.includes("isMigrated")) {
          return {
            domain: {
              name: domain.name,
              isMigrated: domain.isMigrated,
              ownerId: domain.ownerId,
              resolverId: domain.resolverId,
              parentId: domain.parentId,
              expiryDate: domain.expiryDate,
              owner: domain.owner,
              resolver: domain.resolver,
            },
          };
        }

        if (query.includes("parent")) {
          return {
            domain: {
              name: domain.name,
              owner: domain.owner,
              resolver: domain.resolver,
              parent:
                domain.name === "test.eth"
                  ? {
                      name: "eth",
                      owner: {
                        id: "0x0000000000000000000000000000000000000000",
                      },
                      resolver: {
                        address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
                      },
                    }
                  : null,
            },
          };
        }
      }

      // Batch domains query (uses 'ids' parameter, not 'names')
      if (variables?.ids && Array.isArray(variables.ids)) {
        const domains = variables.ids
          .map((namehash: string) =>
            Object.values(mockDomainData).find((d) => d.id === namehash),
          )
          .filter(Boolean);
        return { domains };
      }

      return { domain: null };
    }
  },
}));

// Mock KV namespace
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
} as unknown as KVNamespace;

describe("EnsnodeService", () => {
  const ensnode = new EnsnodeService({
    primaryEndpoint: "https://api.ensnode.test/graphql",
    fallbackEndpoint: "https://api-fallback.ensnode.test/graphql",
  });

  describe("Domain Resolution - Various Types", () => {
    it("should resolve normal unmigrated domain", async () => {
      const { domain, usedFallback } = await ensnode.getDomain("test.eth");

      expect(domain).toBeDefined();
      expect(domain?.name).toBe("test.eth");
      expect(domain?.isMigrated).toBe(false);
      expect(domain?.ownerId).toBe(
        "0x1234567890123456789012345678901234567890",
      );
      expect(usedFallback).toBe(false);
    });

    it("should resolve migrated domain with different characteristics", async () => {
      const { domain, usedFallback } = await ensnode.getDomain("migrated.eth");

      expect(domain).toBeDefined();
      expect(domain?.name).toBe("migrated.eth");
      expect(domain?.isMigrated).toBe(true);
      expect(domain?.ownerId).toBe(
        "0x9876543210987654321098765432109876543210",
      );
      expect(usedFallback).toBe(false);
    });

    it("should handle non-existent domains gracefully", async () => {
      const { domain } = await ensnode.getDomain("nonexistent.eth");
      expect(domain).toBeNull();
    });
  });

  describe("Migration Status - Enhanced Coverage", () => {
    it("should return detailed migration status for unmigrated domain", async () => {
      const { status } = await ensnode.getMigrationStatus("test.eth");

      expect(status).toBeDefined();
      expect(status?.name).toBe("test.eth");
      expect(status?.isMigrated).toBe(false);
      expect(status?.owner?.id).toBe(
        "0x1234567890123456789012345678901234567890",
      );
    });

    it("should return detailed migration status for migrated domain", async () => {
      const { status } = await ensnode.getMigrationStatus("migrated.eth");

      expect(status).toBeDefined();
      expect(status?.name).toBe("migrated.eth");
      expect(status?.isMigrated).toBe(true);
      expect(status?.owner?.id).toBe(
        "0x9876543210987654321098765432109876543210",
      );
    });
  });

  describe("Hierarchy Resolution", () => {
    it("should resolve domain hierarchy with parent structure", async () => {
      const { hierarchy } = await ensnode.getHierarchy("test.eth");

      expect(hierarchy).toBeDefined();
      expect(hierarchy?.name).toBe("test.eth");
      expect(hierarchy?.parent).toBeDefined();
      expect(hierarchy?.parent?.name).toBe("eth");
    });

    it("should handle domains without parent hierarchy", async () => {
      const { hierarchy } = await ensnode.getHierarchy("migrated.eth");

      expect(hierarchy).toBeDefined();
      expect(hierarchy?.name).toBe("migrated.eth");
      // Parent might be null for some domains
    });
  });

  describe("Batch Operations", () => {
    it("should handle batch domain requests efficiently", async () => {
      const names = ["test.eth", "migrated.eth"];
      const { domains } = await ensnode.getDomains(names);

      expect(domains).toBeDefined();
      expect(domains).toHaveLength(2);

      const domainNames = domains?.map((d) => d.name);
      expect(domainNames).toContain("test.eth");
      expect(domainNames).toContain("migrated.eth");
    });

    it("should handle batch requests with mixed valid/invalid domains", async () => {
      const names = ["test.eth", "nonexistent.eth"];
      const { domains } = await ensnode.getDomains(names);

      expect(domains).toBeDefined();
      expect(domains).toHaveLength(1); // Only valid domain returned
      expect(domains?.[0].name).toBe("test.eth");
    });

    it("should handle empty batch requests", async () => {
      const { domains } = await ensnode.getDomains([]);
      expect(domains).toEqual([]);
    });
  });

  describe("Health Check Functionality", () => {
    it("should perform health check with proper latency measurement", async () => {
      const health = await ensnode.healthCheck();

      expect(health.primary).toBe(true);
      expect(health.latency.primary).toBeDefined();
      expect(health.latency.primary).toBeGreaterThanOrEqual(0);
      expect(health.latency.primary).toBeLessThan(100);
    });

    it("should include fallback endpoint status", async () => {
      const health = await ensnode.healthCheck();

      expect(health).toHaveProperty("fallback");
      expect(typeof health.fallback).toBe("boolean");
    });
  });

  describe("Cache Integration", () => {
    const cache = new CacheService(mockKV);

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should generate appropriate cache keys for different operations", () => {
      const domainKey = EnsnodeService.getCacheKey("getDomain", {
        name: "test.eth",
      });
      const migrationKey = EnsnodeService.getCacheKey("getMigrationStatus", {
        name: "test.eth",
      });
      const hierarchyKey = EnsnodeService.getCacheKey("getHierarchy", {
        name: "test.eth",
      });

      expect(domainKey).toBe("ensnode:getDomain:name:test.eth");
      expect(migrationKey).toBe("ensnode:getMigrationStatus:name:test.eth");
      expect(hierarchyKey).toBe("ensnode:getHierarchy:name:test.eth");

      // All keys should be different
      expect(new Set([domainKey, migrationKey, hierarchyKey]).size).toBe(3);
    });

    it("should calculate TTL based on domain migration status", () => {
      const migratedTtl = EnsnodeService.getCacheTTL({
        id: 'test',
        name: 'test.eth',
        labelName: 'test',
        labelhash: '0x123',
        isMigrated: true,
      });
      const unmigratedTtl = EnsnodeService.getCacheTTL({
        id: 'test',
        name: 'test.eth',
        labelName: 'test',
        labelhash: '0x123',
        isMigrated: false,
      });

      // Uniform TTL until v2 migration status is reliable across all networks
      expect(migratedTtl).toBe(300);
      expect(unmigratedTtl).toBe(300);
    });

    it("should use cache service integration points", async () => {
      // Test cache key generation
      const key = CacheKeys.domain("test.eth", "mainnet");
      expect(key).toBe("ensnode:mainnet:domain:test.eth");

      // Test cache operations
      await cache.set("test-key", { data: "test" }, { ttl: 300 });
      expect(mockKV.put).toHaveBeenCalled();

      mockKV.get = vi.fn().mockResolvedValue(
        JSON.stringify({
          data: { test: "data" },
          timestamp: Date.now(),
          ttl: 300,
        }),
      );

      const result = await cache.get("test-key");
      expect(result).toEqual({ test: "data" });
    });
  });

  describe("Performance Characteristics", () => {
    it("should complete basic domain resolution quickly", async () => {
      const start = Date.now();
      await ensnode.getDomain("test.eth");
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // Should be fast with mocks
    });

    it("should handle concurrent requests without interference", async () => {
      const promises = Array.from({ length: 5 }, () =>
        ensnode.getDomain("test.eth"),
      );

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.domain?.name).toBe("test.eth");
      });
    });
  });
});
