import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockEnv } from '../mocks/hono-env';

// Importing the worker pulls the rasterizer. Stub it, as the other route tests do.
vi.mock('../../src/services/rasterize', () => ({
  RasterizeService: class { async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); } },
}));

import { MetadataService } from '../../src/services/metadata';
import { MetadataCacheService } from '../../src/services/metadata-cache';
import app from '../../src/index';

// W8-ROUTES-001: MAX_BATCH_NAMES="1a" is trailing garbage, not a positive integer.
// The documented default cap of 100 applies. parseInt("1a", 10) must not become 1.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function batch(body: unknown, env: Record<string, unknown> = {}) {
  return app.request(
    '/batch-metadata',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true', ...env } as unknown as Record<string, unknown>,
    ctx,
  );
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `name${i}.eth`);

beforeEach(() => {
  vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
  vi.spyOn(MetadataService.prototype, 'getMetadata').mockImplementation(
    async (_network, _registryType, name) => ({ name, description: `${name}, an ENS name.`, attributes: [] }) as never,
  );
  vi.spyOn(MetadataCacheService.prototype, 'get');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('W8-ROUTES-001 invalid MAX_BATCH_NAMES uses the default batch cap', () => {
  it('accepts two names when MAX_BATCH_NAMES is "1a"', async () => {
    const res = await batch(
      { names: ['a.eth', 'b.eth'] },
      { MAX_BATCH_NAMES: '1a' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 2 });
  });

  it('applies the default cap of 100 to trailing garbage, not an unlimited accept', async () => {
    const res = await batch({ names: names(101) }, { MAX_BATCH_NAMES: '1a' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe(
      'Cannot process more than 100 names at once',
    );
  });

  it('still enforces a real positive integer cap', async () => {
    const res = await batch(
      { names: ['a.eth', 'b.eth'] },
      { MAX_BATCH_NAMES: '1' },
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe(
      'Cannot process more than 1 names at once',
    );
  });

  it('treats other trailing garbage as not a positive integer', async () => {
    const res = await batch(
      { names: ['a.eth', 'b.eth', 'c.eth'] },
      { MAX_BATCH_NAMES: '2xyz' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 3 });
  });
});
