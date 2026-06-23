import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Mock rasterize (WASM) — importing ../src/index pulls the whole worker graph.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class { async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); } },
}));

import { errorHandler } from '../src/index';

// Mount the REAL errorHandler on a throwaway app with routes that throw, so we
// exercise the actual handler rather than a copy.
function appThatThrows(thrown: unknown) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/boom', () => { throw thrown; });
  return app;
}

describe('errorHandler (app.onError)', () => {
  it('preserves an HTTPException status (timeout 504 is NOT flattened to 500)', async () => {
    const res = await appThatThrows(new HTTPException(504, { message: 'Gateway Timeout' })).request('/boom');
    expect(res.status).toBe(504);
  });

  it('passes through other HTTPException statuses unchanged', async () => {
    const res = await appThatThrows(new HTTPException(429, { message: 'Too Many Requests' })).request('/boom');
    expect(res.status).toBe(429);
  });

  it('maps a plain unhandled error to a generic 500 (no internal detail leaked)', async () => {
    const res = await appThatThrows(new Error('secret internal failure: db creds')).request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Internal Server Error');
    expect(JSON.stringify(body)).not.toContain('secret internal failure');
  });
});
