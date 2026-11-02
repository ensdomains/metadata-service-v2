import { describe, it, expect, vi, afterEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { createMockEnv } from './mocks/hono-env';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';

// W3-STATUS-001: an HTTPException that reaches a route catch must keep its
// status. The minimized input is this route with checkExpiry throwing 504.
// On main, the catch sends that exception through httpError, which returns 500.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('W3-STATUS-001 HTTPException status at the migration-status catch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /migration-status/status-table.eth returns 504 when checkExpiry throws HTTPException(504)', async () => {
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockRejectedValue(new HTTPException(504));

    const res = await app.request(
      '/migration-status/status-table.eth',
      undefined,
      createMockEnv() as unknown as Record<string, unknown>,
      ctx,
    );

    expect(res.status).toBe(504);
  });
});
