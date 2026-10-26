import { ens_normalize as normalize } from '@adraffy/ens-normalize';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createMockEnv } from '../mocks/hono-env';

vi.mock('../../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../../src/index';
import { AvatarService } from '../../src/services/avatar';
import { MetadataCacheService } from '../../src/services/metadata-cache';
import { MetadataService } from '../../src/services/metadata';

const INVALID_NAME = 'a_b.eth';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = () => ({ ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' }) as never;

let checkExpiry: MockInstance<MetadataService['checkExpiry']>;
let cacheGet: MockInstance<MetadataCacheService['get']>;
let avatar: MockInstance<AvatarService['getAvatarImage']>;
let avatarMeta: MockInstance<AvatarService['getAvatarMeta']>;
let header: MockInstance<AvatarService['getHeaderImage']>;

beforeEach(() => {
  checkExpiry = vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
  cacheGet = vi.spyOn(MetadataCacheService.prototype, 'get');
  avatar = vi.spyOn(AvatarService.prototype, 'getAvatarImage').mockResolvedValue(null);
  avatarMeta = vi.spyOn(AvatarService.prototype, 'getAvatarMeta').mockResolvedValue(null);
  header = vi.spyOn(AvatarService.prototype, 'getHeaderImage').mockResolvedValue(null);
  vi.spyOn(MetadataService.prototype, 'getMigrationStatus').mockResolvedValue(
    { name: INVALID_NAME, migrationStatus: 'unmigrated' } as never,
  );
  vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy').mockResolvedValue(
    { name: INVALID_NAME, hierarchy: [] } as never,
  );
  vi.spyOn(MetadataService.prototype, 'getMetadata').mockResolvedValue(
    { name: INVALID_NAME, description: 'fixture', attributes: [] } as never,
  );
});

afterEach(() => vi.restoreAllMocks());

function get(path: string) {
  return app.request(path, undefined, env(), ctx);
}

describe('SEC-NAME-002: reject ENSIP-15-invalid names before service work', () => {
  it('fixture control: the normative ENSIP-15 implementation rejects the name', () => {
    expect(() => normalize(INVALID_NAME)).toThrow();
  });

  it.each([
    ['avatar', `/mainnet/avatar/${INVALID_NAME}`, () => avatar],
    ['avatar metadata', `/mainnet/avatar/${INVALID_NAME}/meta`, () => avatarMeta],
    ['header', `/mainnet/header/${INVALID_NAME}`, () => header],
    ['migration status', `/migration-status/${INVALID_NAME}`, () => checkExpiry],
    ['hierarchy', `/registry-hierarchy/${INVALID_NAME}`, () => checkExpiry],
  ] as const)('%s returns 400 without invoking its service', async (_label, path, observed) => {
    const response = await get(path);
    expect(response.status).toBe(400);
    expect(observed()).not.toHaveBeenCalled();
  });

  it('batch reports the invalid entry without expiry, cache, or resolver work', async () => {
    const response = await app.request(
      '/batch-metadata',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: [INVALID_NAME] }),
      },
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      successful: 0,
      failed: 1,
      results: [{ name: INVALID_NAME, error: 'Invalid ENS name format' }],
    });
    expect(checkExpiry).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
  });
});
