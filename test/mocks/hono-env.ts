// Mock Cloudflare environment for Hono testing
import { vi } from "vitest";

// Mock KV namespace
export const createMockKV = (): KVNamespace => ({
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi
    .fn()
    .mockResolvedValue({ keys: [], list_complete: true, cursor: "" }),
  getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
});

// Mock D1 database
export const createMockD1 = (): D1Database => {
  const createPreparedStatement = (query: string) => ({
    bind: (...args: unknown[]) => ({
      first: vi.fn().mockImplementation(() => {
        // Mock different responses based on query patterns
        if (query.includes("SELECT") && query.includes("domains")) {
          if (args[0] === "test.eth") {
            return Promise.resolve({
              name: "test.eth",
              data_json: JSON.stringify({
                name: "test.eth",
                isMigrated: false,
              }),
              data_source: "ensnode",
              last_updated: Date.now(),
            });
          }
        }
        return Promise.resolve(null);
      }),
      all: vi.fn().mockImplementation(() => {
        return Promise.resolve({
          results: [],
          success: true,
          meta: { changes: 0 },
        });
      }),
      run: vi.fn().mockImplementation(() => {
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      }),
    }),
  });

  return {
    prepare: vi.fn().mockImplementation(createPreparedStatement),
    dump: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ results: [], success: true }),
    withSession: vi.fn().mockReturnThis(),
  } as D1Database;
};

// Mock R2 bucket
export const createMockR2 = (): R2Bucket => ({
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue({
    key: "test-key",
    etag: "test-etag",
    size: 1024,
    httpMetadata: {},
  }),
  delete: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue({
    objects: [],
    truncated: false,
    cursor: undefined,
  }),
  head: vi.fn().mockResolvedValue(null),
  createMultipartUpload: vi.fn(),
  resumeMultipartUpload: vi.fn(),
});

// Mock Cloudflare environment
export const createMockEnv = () => ({
  // KV Namespaces
  METADATA_CACHE: createMockKV(),
  SVG_CACHE: createMockKV(),

  // R2 Bucket
  ASSET_BUCKET: createMockR2(),

  // D1 Database
  DB: createMockD1(),

  // Environment Variables
  ENSNODE_MAINNET_URL: "https://api.ensnode.test/graphql",
  ENSNODE_SEPOLIA_URL: "https://api.sepolia.ensnode.test/graphql",
  MAINNET_RPC_URL: "https://mainnet.test.rpc",
  SEPOLIA_RPC_URL: "https://sepolia.test.rpc",
  MAINNET_FALLBACK_RPC_1: "https://mainnet-fallback-1.test.rpc",
  MAINNET_FALLBACK_RPC_2: "https://mainnet-fallback-2.test.rpc",
  MAINNET_FALLBACK_RPC_3: "https://mainnet-fallback-3.test.rpc",
  SEPOLIA_FALLBACK_RPC_1: "https://sepolia-fallback-1.test.rpc",
  SEPOLIA_FALLBACK_RPC_2: "https://sepolia-fallback-2.test.rpc",
  LOG_LEVEL: "info",
});

// Test utilities for Hono app testing
export const testRequest = async (
  app: { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> },
  path: string,
  options: RequestInit = {},
) => {
  const url = new URL(path, "http://localhost");
  const request = new Request(url, options);

  // Mock the Cloudflare request context
  const env = createMockEnv();
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };

  return app.fetch(request, env, ctx);
};

// Helper to create test scenarios
export const createTestScenarios = () => ({
  validMetadataRequest: {
    path: "/mainnet/registry/test.eth",
    expected: {
      status: 200,
      name: "test.eth",
      network: "mainnet",
    },
  },
  invalidNetworkRequest: {
    path: "/invalid-network/registry/test.eth",
    expected: {
      status: 400,
      error: "Invalid network",
    },
  },
  invalidRegistryRequest: {
    path: "/mainnet/invalid-registry/test.eth",
    expected: {
      status: 400,
      error: "Invalid registry type",
    },
  },
  migrationStatusRequest: {
    path: "/migration-status/test.eth",
    expected: {
      status: 200,
      name: "test.eth",
      migrationStatus: "unmigrated",
    },
  },
  hierarchyRequest: {
    path: "/registry-hierarchy/test.eth",
    expected: {
      status: 200,
      name: "test.eth",
      hierarchy: [],
    },
  },
  batchRequest: {
    path: "/batch-metadata",
    method: "POST",
    body: {
      names: ["test.eth", "migrated.eth"],
      network: "mainnet",
    },
    expected: {
      status: 200,
      results: [],
      total: 0,
    },
  },
  healthRequest: {
    path: "/health",
    expected: {
      status: 200,
      service: "ENS Metadata V2",
      version: "2.0.0",
      health: "ok",
    },
  },
});
