import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from 'ens-metadata-v2';

describe('package entrypoint', () => {
  it('exposes the Worker app by package name', async () => {
    const response = await app.request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'ENS Metadata V2' });
  });
});
