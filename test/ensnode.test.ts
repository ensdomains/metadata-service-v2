import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnsnodeService } from '../src/services/ensnode';
import { CacheService, CacheKeys } from '../src/services/cache';

// Mock the namehash function
vi.mock('../src/utils/ens', () => ({
  namehash: (name: string) => {
    // Return predictable hash for test.eth
    if (name === 'test.eth') {
      return '0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658';
    }
    if (name === 'nonexistent.eth') {
      return '0x1111111111111111111111111111111111111111111111111111111111111111';
    }
    return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
}));

// Mock GraphQL client
vi.mock('graphql-request', () => ({
  GraphQLClient: class {
    constructor(public endpoint: string) {}
    async request(query: string, variables?: any) {
      // Add small delay for realistic latency testing
      await new Promise(resolve => setTimeout(resolve, 1));
      // Mock response for test domains using namehash
      if (variables?.name === '0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658') {
        return {
          domain: {
            id: '0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658',
            name: 'test.eth',
            labelName: 'test',
            labelhash: '0x1234567890abcdef',
            ownerId: '0x1234567890123456789012345678901234567890',
            resolverId: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
            registrantId: '0x1234567890123456789012345678901234567890',
            owner: { id: '0x1234567890123456789012345678901234567890' },
            resolver: { address: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' },
            registrant: { id: '0x1234567890123456789012345678901234567890' },
            isMigrated: false,
            createdAt: '1640995200',
          }
        };
      }

      // Mock response for ID parameter (migration status, hierarchy)
      if (variables?.id === '0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658') {
        return {
          domain: {
            name: 'test.eth',
            isMigrated: false,
            ownerId: '0x1234567890123456789012345678901234567890',
            resolverId: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
            parentId: '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae',
            expiryDate: '1735689600',
            owner: { id: '0x1234567890123456789012345678901234567890' },
            resolver: { address: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' }
          }
        };
      }

      if (query.includes('domains(first: 1)')) {
        return { domains: [{ id: 'test.eth' }] };
      }

      // Return null for unknown domains instead of throwing error
      return { domain: null };
    }
  }
}));

// Mock KV namespace
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
} as unknown as KVNamespace;

describe('EnsnodeService', () => {
  const ensnode = new EnsnodeService({
    primaryEndpoint: 'https://api.ensnode.test/graphql',
  });

  describe('getDomain', () => {
    it('should return domain data', async () => {
      const { domain, usedFallback } = await ensnode.getDomain('test.eth');

      expect(domain).toBeDefined();
      expect(domain?.name).toBe('test.eth');
      expect(domain?.isMigrated).toBe(false);
      expect(usedFallback).toBe(false);
    });

    it('should handle non-existent domains', async () => {
      const { domain } = await ensnode.getDomain('nonexistent.eth');
      expect(domain).toBeNull();
    });
  });

  describe('getMigrationStatus', () => {
    it('should return migration status', async () => {
      const { status } = await ensnode.getMigrationStatus('test.eth');

      expect(status).toBeDefined();
      expect(status?.name).toBe('test.eth');
      expect(status?.isMigrated).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('should perform health check', async () => {
      const health = await ensnode.healthCheck();

      expect(health.primary).toBe(true);
      expect(health.latency.primary).toBeGreaterThan(0);
    });
  });

  describe('static methods', () => {
    it('should convert migration status', () => {
      const status = EnsnodeService.convertMigrationStatus({
        name: 'test.eth',
        isMigrated: false,
      });

      expect(status).toBe('unmigrated');
    });

    it('should generate cache keys', () => {
      const key = EnsnodeService.getCacheKey('getDomain', { name: 'test.eth' });
      expect(key).toBe('ensnode:getDomain:name:test.eth');
    });

    it('should calculate cache TTL', () => {
      const ttl = EnsnodeService.getCacheTTL({
        id: 'test.eth',
        name: 'test.eth',
        labelName: 'test',
        labelhash: '0x123',
        isMigrated: true,
      });

      expect(ttl).toBe(3600); // 1 hour for migrated domains
    });
  });
});

describe('CacheService', () => {
  const cache = new CacheService(mockKV);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cache operations', () => {
    it('should generate correct cache keys', () => {
      const key = CacheKeys.domain('test.eth');
      expect(key).toBe('domain:test.eth');

      const batchKey = CacheKeys.domains(['test.eth', 'example.eth']);
      expect(batchKey).toBe('domains:example.eth,test.eth');
    });

    it('should set cache entry', async () => {
      await cache.set('test-key', { data: 'test' }, { ttl: 300 });

      expect(mockKV.put).toHaveBeenCalledWith(
        'ensnode:test-key',
        expect.any(String),
        { expirationTtl: 300 }
      );
    });

    it('should get cache entry', async () => {
      mockKV.get = vi.fn().mockResolvedValue(JSON.stringify({
        data: { test: 'data' },
        timestamp: Date.now(),
        ttl: 300,
      }));

      const result = await cache.get('test-key');
      expect(result).toEqual({ test: 'data' });
    });

    it('should handle cache miss', async () => {
      mockKV.get = vi.fn().mockResolvedValue(null);

      const result = await cache.get('missing-key');
      expect(result).toBeNull();
    });
  });
});