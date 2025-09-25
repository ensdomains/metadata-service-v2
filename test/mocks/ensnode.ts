// Mock for ensnode GraphQL responses
import { vi } from "vitest";

export interface MockDomain {
  id: string;
  name: string;
  labelName: string;
  labelhash: string;
  ownerId: string;
  resolverId: string;
  registrantId: string;
  isMigrated: boolean;
  createdAt: string;
  expiryDate?: string;
  parentId?: string;
}

export interface MockHierarchy {
  name: string;
  owner: { id: string };
  resolver: { address: string };
  parent?: MockHierarchy;
}

// Test data for different domain types
export const mockDomains: Record<string, MockDomain> = {
  "test.eth": {
    id: "0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658",
    name: "test.eth",
    labelName: "test",
    labelhash:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    ownerId: "0x1234567890123456789012345678901234567890",
    resolverId: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
    registrantId: "0x1234567890123456789012345678901234567890",
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
    isMigrated: true,
    createdAt: "1640995200",
    expiryDate: "1735689600",
    parentId:
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
  },
  "subdomain.test.eth": {
    id: "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    name: "subdomain.test.eth",
    labelName: "subdomain",
    labelhash:
      "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    ownerId: "0x1111111111111111111111111111111111111111",
    resolverId: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
    registrantId: "0x1111111111111111111111111111111111111111",
    isMigrated: false,
    createdAt: "1640995200",
    parentId:
      "0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658",
  },
  "expired.eth": {
    id: "0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffff",
    name: "expired.eth",
    labelName: "expired",
    labelhash:
      "0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffff",
    ownerId: "0x0000000000000000000000000000000000000000",
    resolverId: "0x0000000000000000000000000000000000000000",
    registrantId: "0x0000000000000000000000000000000000000000",
    isMigrated: false,
    createdAt: "1640995200",
    expiryDate: "1640995200", // Expired
    parentId:
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
  },
};

// Mock hierarchies for testing
export const mockHierarchies: Record<string, MockHierarchy> = {
  "test.eth": {
    name: "test.eth",
    owner: { id: "0x1234567890123456789012345678901234567890" },
    resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
    parent: {
      name: "eth",
      owner: { id: "0x0000000000000000000000000000000000000000" },
      resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
    },
  },
  "subdomain.test.eth": {
    name: "subdomain.test.eth",
    owner: { id: "0x1111111111111111111111111111111111111111" },
    resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
    parent: {
      name: "test.eth",
      owner: { id: "0x1234567890123456789012345678901234567890" },
      resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
      parent: {
        name: "eth",
        owner: { id: "0x0000000000000000000000000000000000000000" },
        resolver: { address: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" },
      },
    },
  },
};

// Helper to convert domain name to mock namehash
export function getMockNamehash(name: string): string {
  const domain = mockDomains[name];
  if (domain) {
    return domain.id;
  }

  // Generate predictable hash for unknown domains
  if (name === "nonexistent.eth") {
    return "0x1111111111111111111111111111111111111111111111111111111111111111";
  }

  return "0x0000000000000000000000000000000000000000000000000000000000000000";
}

// Mock GraphQL responses based on query patterns
export function createMockEnsnodeResponse(query: string, variables: any) {
  // Domain query by name (namehash)
  if (variables?.name && query.includes("domain(id:")) {
    const domain = Object.values(mockDomains).find(
      (d) => d.id === variables.name,
    );
    if (!domain) return { domain: null };

    return {
      domain: {
        id: domain.id,
        name: domain.name,
        labelName: domain.labelName,
        labelhash: domain.labelhash,
        ownerId: domain.ownerId,
        resolverId: domain.resolverId,
        registrantId: domain.registrantId,
        owner: { id: domain.ownerId },
        resolver: { address: domain.resolverId },
        registrant: { id: domain.registrantId },
        isMigrated: domain.isMigrated,
        createdAt: domain.createdAt,
        expiryDate: domain.expiryDate,
        parentId: domain.parentId,
      },
    };
  }

  // Migration status query
  if (variables?.id && query.includes("isMigrated")) {
    const domain = Object.values(mockDomains).find(
      (d) => d.id === variables.id,
    );
    if (!domain) return { domain: null };

    return {
      domain: {
        name: domain.name,
        isMigrated: domain.isMigrated,
        ownerId: domain.ownerId,
        resolverId: domain.resolverId,
        parentId: domain.parentId,
        expiryDate: domain.expiryDate,
        owner: { id: domain.ownerId },
        resolver: { address: domain.resolverId },
      },
    };
  }

  // Hierarchy query
  if (variables?.id && query.includes("parent")) {
    const domainName = Object.values(mockDomains).find(
      (d) => d.id === variables.id,
    )?.name;
    if (!domainName) return { domain: null };

    const hierarchy = mockHierarchies[domainName];
    if (!hierarchy) return { domain: null };

    return {
      domain: hierarchy,
    };
  }

  // Batch domain query
  if (
    variables?.names &&
    Array.isArray(variables.names) &&
    query.includes("domains(where:")
  ) {
    const domains = variables.names
      .map((namehash: string) =>
        Object.values(mockDomains).find((d) => d.id === namehash),
      )
      .filter(Boolean)
      .map((domain: MockDomain) => ({
        id: domain.id,
        name: domain.name,
        labelName: domain.labelName,
        labelhash: domain.labelhash,
        ownerId: domain.ownerId,
        resolverId: domain.resolverId,
        registrantId: domain.registrantId,
        owner: { id: domain.ownerId },
        resolver: { address: domain.resolverId },
        registrant: { id: domain.registrantId },
        isMigrated: domain.isMigrated,
        createdAt: domain.createdAt,
        expiryDate: domain.expiryDate,
        parentId: domain.parentId,
      }));

    return { domains };
  }

  // Health check query
  if (query.includes("domains(first: 1)")) {
    return {
      domains: [{ id: "test.eth", name: "test.eth" }],
    };
  }

  // Default fallback
  return { domain: null, domains: [] };
}

// Enhanced mock for GraphQLClient
export const mockGraphQLClient = vi
  .fn()
  .mockImplementation((endpoint: string) => ({
    endpoint,
    async request(query: string, variables?: any) {
      // Simulate network latency
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 10 + 1),
      );

      // Simulate occasional network errors for testing fallback
      if (endpoint.includes("fallback") && Math.random() < 0.1) {
        throw new Error("Network error - fallback endpoint");
      }

      return createMockEnsnodeResponse(query, variables);
    },
  }));

// Mock for testing error scenarios
export function createFailingMockClient(
  errorType: "network" | "timeout" | "invalid" = "network",
) {
  return vi.fn().mockImplementation(() => ({
    async request() {
      await new Promise((resolve) => setTimeout(resolve, 1));

      switch (errorType) {
        case "network":
          throw new Error("Network error: ensnode service unavailable");
        case "timeout":
          await new Promise((resolve) => setTimeout(resolve, 5000)); // Simulate timeout
          throw new Error("Request timeout");
        case "invalid":
          return { invalid: "response" };
        default:
          throw new Error("Unknown error");
      }
    },
  }));
}

// Test scenarios for different domain states
export const testScenarios = {
  normalDomain: "test.eth",
  migratedDomain: "migrated.eth",
  subDomain: "subdomain.test.eth",
  expiredDomain: "expired.eth",
  nonExistentDomain: "nonexistent.eth",
  invalidDomain: "invalid..eth",
  unicodeDomain: "🚀.eth",
};
