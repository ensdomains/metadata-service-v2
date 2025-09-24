import { describe, it, expect } from 'vitest';
import app from '../src/index';

describe('API Endpoints', () => {
  describe('Metadata endpoint', () => {
    it('should return metadata for valid request', async () => {
      const res = await app.request('/namechain/registry/test.eth');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.name).toBe('test.eth');
      expect(data.network).toBe('namechain');
      expect(data.attributes).toBeDefined();
    });

    it('should reject invalid network', async () => {
      const res = await app.request('/invalid/registry/test.eth');
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain('Invalid network');
    });

    it('should reject invalid registry type', async () => {
      const res = await app.request('/mainnet/invalid/test.eth');
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain('Invalid registry type');
    });

    it('should reject empty identifier', async () => {
      const res = await app.request('/mainnet/registry/');
      expect(res.status).toBe(404);
    });
  });

  describe('Migration status endpoint', () => {
    it('should return migration status for valid name', async () => {
      const res = await app.request('/migration-status/test.eth');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.name).toBe('test.eth');
      expect(data.status).toBeDefined();
      expect(['native', 'ejected', 'unmigrated', 'shadow']).toContain(data.status);
    });

    it('should reject invalid ENS name', async () => {
      const res = await app.request('/migration-status/invalid');
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain('Invalid ENS name format');
    });
  });

  describe('Registry hierarchy endpoint', () => {
    it('should return hierarchy for valid name', async () => {
      const res = await app.request('/registry-hierarchy/test.eth');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.name).toBe('test.eth');
      expect(Array.isArray(data.hierarchy)).toBe(true);
      expect(data.hierarchy.length).toBeGreaterThan(0);
    });

    it('should reject invalid ENS name', async () => {
      const res = await app.request('/registry-hierarchy/invalid');
      expect(res.status).toBe(400);
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

      const data = await res.json();
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

      const data = await res.json();
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

      const data = await res.json();
      expect(data.error).toContain('Cannot process more than 100 names');
    });

    it('should reject missing names array', async () => {
      const res = await app.request('/batch-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain("must contain 'names' array");
    });
  });

  describe('Health endpoint', () => {
    it('should return health status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.service).toBe('ENS Metadata V2');
      expect(data.version).toBe('2.0.0');
      expect(data.status).toBe('ok');
      expect(data.dependencies).toBeDefined();
    });
  });
});