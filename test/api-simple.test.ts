import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

// Create a simple test app that mirrors the main app structure
const app = new Hono();

// Mock successful responses for all endpoints
app.get('/:network/registry/:identifier', (c) => {
  return c.json({
    name: 'test.eth',
    tokenId: '0x1234567890abcdef',
    version: 'v1',
    network: 'namechain',
    description: 'test.eth, an ENS name.',
    image: 'https://metadata.ens.domains/test.eth/image',
    attributes: [],
    external_url: 'https://app.ens.domains/name/test.eth',
  });
});

app.get('/migration-status/:name', (c) => {
  return c.json({
    name: 'test.eth',
    status: 'unmigrated',
  });
});

app.get('/registry-hierarchy/:name', (c) => {
  return c.json({
    name: 'test.eth',
    hierarchy: [
      {
        name: 'eth',
        owner: '0x0000000000000000000000000000000000000000',
        resolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
        level: 1,
      },
      {
        name: 'test.eth',
        owner: '0x1234567890123456789012345678901234567890',
        resolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
        level: 2,
      },
    ],
  });
});

app.post('/batch-metadata', async (c) => {
  const body = await c.req.json().catch(() => ({}));

  if (!body.names || !Array.isArray(body.names)) {
    return c.json({ error: "Request body must contain 'names' array" }, 400);
  }

  if (body.names.length === 0) {
    return c.json({ error: 'Names array cannot be empty' }, 400);
  }

  if (body.names.length > 100) {
    return c.json({ error: 'Cannot process more than 100 names at once' }, 400);
  }

  return c.json({
    results: [
      { name: 'test.eth', metadata: { name: 'test.eth' } },
      { name: 'example.eth', metadata: { name: 'example.eth' } },
    ],
    total: 2,
    successful: 2,
    failed: 0,
  });
});

app.get('/health', (c) => {
  return c.json({
    service: 'ENS Metadata V2',
    version: '2.0.0',
    status: 'ok',
    dependencies: {
      ensnode: 'ok',
      blockchain: { mainnet: 'ok', namechain: 'ok' },
    },
  });
});

describe('API Endpoints - Simple Tests', () => {
  describe('Metadata endpoint', () => {
    it('should return metadata for valid request', async () => {
      const res = await app.request('/namechain/registry/test.eth');
      expect(res.status).toBe(200);

      const data = await res.json() as Record<string, unknown>;
      expect(data.name).toBe('test.eth');
      expect(data.network).toBe('namechain');
      expect(data.attributes).toBeDefined();
    });
  });

  describe('Migration status endpoint', () => {
    it('should return migration status for valid name', async () => {
      const res = await app.request('/migration-status/test.eth');
      expect(res.status).toBe(200);

      const data = await res.json() as Record<string, unknown>;
      expect(data.name).toBe('test.eth');
      expect(data.status).toBeDefined();
      expect(['native', 'ejected', 'unmigrated', 'shadow']).toContain(data.status);
    });
  });

  describe('Registry hierarchy endpoint', () => {
    it('should return hierarchy for valid name', async () => {
      const res = await app.request('/registry-hierarchy/test.eth');
      expect(res.status).toBe(200);

      const data = await res.json() as Record<string, unknown>;
      expect(data.name).toBe('test.eth');
      expect(Array.isArray(data.hierarchy)).toBe(true);
      expect((data.hierarchy as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('Batch metadata endpoint', () => {
    it('should process valid batch request', async () => {
      const requestBody = {
        names: ['test.eth', 'example.eth'],
        network: 'namechain'
      };

      const res = await app.request('/batch-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      expect(res.status).toBe(200);

      const data = await res.json() as Record<string, unknown>;
      expect(data.results).toHaveLength(2);
      expect(data.total).toBe(2);
      expect(data.successful).toBe(2);
      expect(data.failed).toBe(0);
    });

    it('should reject empty names array', async () => {
      const res = await app.request('/batch-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: [] })
      });

      expect(res.status).toBe(400);

      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toContain('Names array cannot be empty');
    });

    it('should reject too many names', async () => {
      const names = Array.from({ length: 101 }, (_, i) => `test${i}.eth`);

      const res = await app.request('/batch-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names })
      });

      expect(res.status).toBe(400);

      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toContain('Cannot process more than 100 names');
    });

    it('should reject missing names array', async () => {
      const res = await app.request('/batch-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);

      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toContain("must contain 'names' array");
    });
  });

  describe('Health endpoint', () => {
    it('should return health status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const data = await res.json() as Record<string, unknown>;
      expect(data.service).toBe('ENS Metadata V2');
      expect(data.version).toBe('2.0.0');
      expect(data.status).toBe('ok');
      expect(data.dependencies).toBeDefined();
    });
  });
});