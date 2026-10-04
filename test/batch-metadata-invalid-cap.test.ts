import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Mock rasterize (WASM) — importing ../src/index pulls the whole worker graph.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class { async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); } },
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function names(count: number) {
  return Array.from({ length: count }, (_, index) => `name${index}.eth`);
}

function batch(batchNames: string[], maxBatchNames: string) {
  return app.request(
    '/batch-metadata',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: batchNames }),
    },
    {
      ...createMockEnv(),
      RATE_LIMIT_DISABLED: 'true',
      MAX_BATCH_NAMES: maxBatchNames,
    },
    ctx,
  );
}

beforeEach(() => {
  vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
  vi.spyOn(MetadataService.prototype, 'getMetadata').mockImplementation(async (_network, _registryType, name) => ({
    name,
    description: `${name}, an ENS name.`,
    attributes: [],
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /batch-metadata with an invalid MAX_BATCH_NAMES', () => {
  it('uses the default cap for the entire invalid value while preserving valid caps', async () => {
    const minimized = await batch(['a.eth', 'b.eth'], '1a');
    const minimizedBody = await minimized.json() as { total?: number; error?: string };
    expect({ status: minimized.status, error: minimizedBody.error })
      .toEqual({ status: 200, error: undefined });
    expect(minimizedBody).toMatchObject({ total: 2 });

    const overDefault = await batch(names(101), '1a');
    expect(overDefault.status).toBe(400);
    expect((await overDefault.json() as { error: string }).error)
      .toBe('Cannot process more than 100 names at once');

    const validCap = await batch(['a.eth', 'b.eth'], '1');
    expect(validCap.status).toBe(400);
    expect((await validCap.json() as { error: string }).error)
      .toBe('Cannot process more than 1 names at once');

    const otherGarbage = await batch(['a.eth', 'b.eth', 'c.eth'], '2xyz');
    expect(otherGarbage.status).toBe(200);
  });
});
