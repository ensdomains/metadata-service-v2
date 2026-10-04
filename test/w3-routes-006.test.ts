import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// Captured per-colo edge copy. edgeCachePut stores a clone whose Cache-Control
// is the edge TTL; the response returned to the client keeps its own header.
const edgeStore = new Map<string, Response>();
const keyOf = (r: RequestInfo | URL | Request) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : (r as Request).url;

const fakeDefaultCache = {
  async match(req: RequestInfo | URL) {
    return edgeStore.get(keyOf(req))?.clone();
  },
  async put(req: RequestInfo | URL, res: Response) {
    edgeStore.set(keyOf(req), res.clone());
  },
  async delete(req: RequestInfo | URL) {
    return edgeStore.delete(keyOf(req));
  },
};
(globalThis as unknown as { caches: unknown }).caches = { default: fakeDefaultCache };

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

import { MetadataService, isDegradedMigrationStatus } from '../src/services/metadata';
import { FallbackService } from '../src/services/fallback';
import { D1Service } from '../src/services/d1';
import { NotFoundError } from '../src/services/errors';
import { MIGRATION_STATUS } from '../src/types';
import app from '../src/index';

const NAME = 'non-definitive-migration.eth';
const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const EXPIRY = '2030-01-01T00:00:00.000Z';
const PATH = `/migration-status/${NAME}?network=sepolia`;
const DEGRADED_CACHE = 'public, max-age=30';

function makeKV() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

function makeSepoliaMetadataService(): MetadataService {
  return new MetadataService(
    {
      indexerV2Endpoint: 'https://zigens.test/graphql',
      indexerV2ApiVersion: 'v2',
      indexerV1Endpoint: 'https://ensnode-v1.test/subgraph',
      network: 'sepolia',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    makeKV(),
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
}

function makeAppCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

function stubNonDefinitiveD1Rescue() {
  const miss = new NotFoundError('getMigrationStatus: not found in any source', {
    definitive: false,
  });
  vi.spyOn(FallbackService.prototype, 'getMigrationStatus').mockRejectedValue(miss);
  vi.spyOn(D1Service.prototype, 'getMigrationStatus').mockResolvedValue({
    name: NAME,
    status: MIGRATION_STATUS.MIGRATED,
    owner: OWNER,
    expiration_date: EXPIRY,
  } as Awaited<ReturnType<D1Service['getMigrationStatus']>>);
  vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.restoreAllMocks();
  edgeStore.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('W3-ROUTES-006: D1 rescue after a non-definitive live miss', () => {
  type Stubbable = {
    fallback: { getMigrationStatus: ReturnType<typeof vi.fn> };
    d1?: { getMigrationStatus: ReturnType<typeof vi.fn> };
  };

  it('marks the rescued service value as privately degraded', async () => {
    const svc = makeSepoliaMetadataService();
    const nonDefinitiveMiss = new NotFoundError(
      'getMigrationStatus: not found in any source',
      { definitive: false },
    );
    (svc as unknown as Stubbable).fallback = {
      getMigrationStatus: vi.fn().mockRejectedValue(nonDefinitiveMiss),
    };
    (svc as unknown as Stubbable).d1 = {
      getMigrationStatus: vi.fn().mockResolvedValue({
        name: NAME,
        status: 'migrated',
        owner: OWNER,
        expiration_date: EXPIRY,
      }),
    };

    const result = await svc.getMigrationStatus(NAME);

    expect(result.name).toBe(NAME);
    expect(result.status).toBe('migrated');
    expect(isDegradedMigrationStatus(result)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      name: NAME,
      status: 'migrated',
      owner: OWNER,
      expirationDate: EXPIRY,
    });
  });

  it('publishes provenance-free JSON with literal client and edge max-age=30', async () => {
    stubNonDefinitiveD1Rescue();
    const env = createMockEnv() as unknown as Record<string, unknown>;
    const { ctx, flush } = makeAppCtx();

    const res = await app.request(PATH, undefined, env, ctx);
    await flush();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: NAME,
      status: 'migrated',
      owner: OWNER,
      expirationDate: EXPIRY,
    });
    expect(res.headers.get('Cache-Control')).toBe(DEGRADED_CACHE);

    const edge = edgeStore.get(`http://localhost${PATH}`);
    expect(edge?.headers.get('Cache-Control')).toBe(DEGRADED_CACHE);
  });
});
