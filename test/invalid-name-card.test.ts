import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { maskedName } from '../src/utils/ens';
import { ImageGenerationService } from '../src/services/image';
import { ImageCacheService } from '../src/services/image-cache';
import { MetadataService, type D1RecordData } from '../src/services/metadata';
import { StorageManager } from '../src/utils/storage';
import type { AvatarService } from '../src/services/avatar';
import { createMockKV, createMockR2 } from './mocks/hono-env';

// A name that isn't normalized can pass for another name (uppercase, look-alike
// or invisible characters), so v1 (metadata.ens.domains) never shows it: its
// card and metadata show the token id, shortened, on a red "Invalid name" card,
// with no avatar and no app link. This service drew such names as given.

const satoshi = readFileSync(new URL('../node_modules/adaptive-layout-composer/assets/Satoshi-Bold.ttf', import.meta.url));
const satoshiBuffer = satoshi.buffer.slice(satoshi.byteOffset, satoshi.byteOffset + satoshi.byteLength);
const bucket = { get: async () => ({ arrayBuffer: async () => satoshiBuffer }) } as unknown as R2Bucket;

describe('maskedName', () => {
  it.each([
    ['ab_c.eth', 'registry', '[0xf96b...0db8].eth'], // labelhash('ab_c'): the .eth registrar's token id
    ['ab_c.eth', 'namewrapper', '[0x5859...08c2].eth'], // namehash('ab_c.eth'), hashed as given
    ['Sub.ab_c.eth', 'registry', '[0x1e97...a081].eth'], // a subname has no registrar token: the namehash
  ] as const)('shows %s on the %s route as %s', (name, registryType, shown) => {
    expect(maskedName(name, registryType)).toBe(shown);
  });
});

describe("the card of a name that isn't normalized", () => {
  const svc = new ImageGenerationService();

  it.each(['unmigrated', 'migrated'] as const)("is v1's invalid-name card for a %s name", async (migrationStatus) => {
    const { svg } = await svc.generateDomainImage({
      name: 'Ab_c.eth', migrationStatus, avatarBase64: 'iVBORw0KGgo=', avatarMimeType: 'image/png',
    }, bucket);
    expect(svg).toContain('fill="url(#invalidName)"');
    expect(svg).toContain('<stop stop-color="#EB9E9E"/><stop offset="1" stop-color="#992222"/>');
    expect(svg).toContain('d="M217.472 44.4655'); // the warning sign
    expect(svg).toContain(`>${maskedName('Ab_c.eth', 'registry')}</text>`);
    expect(svg).not.toContain('Ab_c');
    expect(svg).not.toContain('<image'); // no avatar
    expect(svg).not.toContain('layout'); // not the ENS v2 card
  });

  it("shows the NameWrapper's token id on the namewrapper route", async () => {
    const { svg } = await svc.generateDomainImage({ name: 'ab_c.eth', registryType: 'namewrapper' }, bucket);
    expect(svg).toContain('>[0x5859...08c2].eth</text>');
  });

  it('never looks the avatar up, and is cached per route', async () => {
    const kv = createMockKV();
    const avatarService = { getAvatarImage: vi.fn(), getAvatarBase64: vi.fn(), getTextRecord: vi.fn() };
    const cache = new ImageCacheService(kv, new StorageManager(createMockR2()), new ImageGenerationService(avatarService as unknown as AvatarService), avatarService as unknown as AvatarService, 'mainnet');
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    await cache.getImage('ab_c.eth', { name: 'ab_c.eth', registryType: 'registry' }, ctx);
    await cache.getImage('ab_c.eth', { name: 'ab_c.eth', registryType: 'namewrapper' }, ctx);
    expect(avatarService.getAvatarImage).not.toHaveBeenCalled();
    expect(avatarService.getAvatarBase64).not.toHaveBeenCalled();
    expect(avatarService.getTextRecord).not.toHaveBeenCalled();
    const keys = vi.mocked(kv.get).mock.calls.map((call) => String(call[0]));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.every((k) => k.startsWith('svg:ab_c.eth:'))).toBe(true); // webhook invalidation prefix
  });

  it('is never served for the normalized name it differs from in case', async () => {
    const store = new Map<string, string>();
    const kv = { ...createMockKV(), get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } as unknown as KVNamespace;
    const avatarService = { getAvatarImage: vi.fn().mockResolvedValue(null), getTextRecord: vi.fn() } as unknown as AvatarService;
    const cache = new ImageCacheService(kv, new StorageManager(createMockR2()), new ImageGenerationService(avatarService), avatarService, 'mainnet');
    const writes: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => writes.push(p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    expect((await cache.getImage('AB-C.eth', { name: 'AB-C.eth' }, ctx)).svg).toContain('url(#invalidName)');
    await Promise.all(writes);
    expect((await cache.getImage('ab-c.eth', { name: 'ab-c.eth' }, ctx)).svg).not.toContain('url(#invalidName)');
  });
});

describe("the metadata of a name that isn't normalized", () => {
  const svc = new MetadataService(
    { indexerV2Endpoint: 'https://indexer.test', network: 'mainnet', fallbackToBlockchain: false, internalCacheEnabled: false, d1Enabled: false },
    createMockKV(),
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
  const build = (name: string, registryType: 'registry' | 'namewrapper' = 'registry') =>
    (svc as unknown as { buildMetadataFromD1Record: (r: D1RecordData, n: string, b: string, t: string) => Promise<Record<string, unknown>> })
      .buildMetadataFromD1Record({ name, labelhash: '0x', is_migrated: false, data_source: 'test' }, 'mainnet', 'https://meta.test', registryType);

  it('is shown as v1 shows it', async () => {
    const meta = await build('Ab_c.eth');
    expect(meta).toMatchObject({
      is_normalized: false,
      name: maskedName('Ab_c.eth', 'registry'),
      description: `${maskedName('Ab_c.eth', 'registry')}, an ENS name. (Ab_c.eth is not in normalized form)`,
      url: null,
    });
    expect(meta).not.toHaveProperty('background_image');
    expect(meta.image).toBe('https://meta.test/mainnet/registry/Ab_c.eth/image');
  });

  it('is unchanged for a normalized name', async () => {
    expect(await build('ab-c.eth')).toMatchObject({
      is_normalized: true,
      name: 'ab-c.eth',
      description: 'ab-c.eth, an ENS name.',
      url: 'https://app.ens.domains/name/ab-c.eth',
      background_image: 'https://meta.test/mainnet/avatar/ab-c.eth',
    });
  });
});
