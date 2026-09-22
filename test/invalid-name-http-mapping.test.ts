import { describe, it, expect, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

// Make the service layer itself raise InvalidNameError (the v1 contract/tokenId
// path bypasses the route's own name check, so this exercises the httpError
// mapping rather than the route guard). Everything else in the module is kept.
vi.mock('../src/services/metadata', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/metadata')>();
  const { InvalidNameError } = await import('../src/services/errors');
  return {
    ...orig,
    MetadataService: class {
      async resolveTokenId() { throw new InvalidNameError(); }
      async checkExpiry() {}
    },
  };
});

import app from '../src/index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string) =>
  app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

const BASE_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';

describe('httpError maps a service-level InvalidNameError to 400 (was 500)', () => {
  for (const suffix of ['', '/image', '/rasterize']) {
    it(`GET /:network/<contract>/<tokenId>${suffix}`, async () => {
      const res = await req(`/mainnet/${BASE_REGISTRAR}/123${suffix}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('Invalid ENS name format');
    });
  }
});
