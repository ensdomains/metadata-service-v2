import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock rasterize service to avoid WASM import issues in Vite (same as index.test.ts)
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

import app from '../src/index';
import { BlockchainService } from '../src/services/blockchain';
import { MetadataService, DomainExpiredError } from '../src/services/metadata';

// Expiry gates:
//  1) getMetadata 410s a name whose indexer expiry has passed, and serves one
//     whose expiry is ahead.
//  2) /batch-metadata must run the same per-name checkExpiry gate as the
//     single-name GET, BEFORE the shared KV metadata cache.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const LAPSED_EXPIRY = String(Math.floor(Date.now() / 1000) - 150 * 86400); // lapsed months ago
const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 365 * 86400; // ~1y in the future

function makeService(network: 'mainnet' | 'sepolia'): MetadataService {
  return new MetadataService(
    {
      indexerV2Endpoint: 'https://sepolia.api.bigname.test',
      network,
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
}

type Priv = {
  fallback: Record<string, ReturnType<typeof vi.fn>>;
  blockchain: Record<string, ReturnType<typeof vi.fn>>;
};

function stubIndexerRow(
  svc: MetadataService,
  opts: { expiryDate: string; blockchain: Record<string, ReturnType<typeof vi.fn>> },
): Priv {
  const p = svc as unknown as Priv;
  const result = {
    data: {
      name: 'fox.eth',
      id: '0x1234',
      labelName: 'fox',
      owner: { id: OWNER },
      protocol: 'v2',
      expiryDate: opts.expiryDate,
    },
    source: 'indexerV2' as const,
    usedFallback: false,
    v2Consulted: true,
    fallthroughs: 0,
  };
  p.fallback = {
    getDomainMetadata: vi.fn().mockResolvedValue(result),
    getMigrationStatus: vi.fn().mockResolvedValue(result),
  };
  p.blockchain = opts.blockchain;
  return p;
}

describe('getMetadata: the indexer expiry gate', () => {
  it('410s a name whose indexer expiry has passed', async () => {
    const svc = makeService('sepolia');
    stubIndexerRow(svc, { expiryDate: LAPSED_EXPIRY, blockchain: {} });
    await expect(
      svc.getMetadata('sepolia', 'registry', 'fox.eth', 'https://meta.test'),
    ).rejects.toBeInstanceOf(DomainExpiredError);
  });

  it('serves a name whose indexer expiry is ahead', async () => {
    const svc = makeService('sepolia');
    stubIndexerRow(svc, { expiryDate: String(FUTURE_EXPIRY), blockchain: {} });
    const meta = await svc.getMetadata('sepolia', 'registry', 'fox.eth', 'https://meta.test');
    expect(meta.name).toBe('fox.eth');
  });

  it('checkExpiry prefers a live v2 registration over a lapsed v1 registrar expiry', async () => {
    // fox.eth on sepolia: REGISTERED on v2 until well in the future, expired on
    // the v1 registrar.
    const svc = makeService('sepolia');
    stubIndexerRow(svc, {
      expiryDate: String(FUTURE_EXPIRY),
      blockchain: {
        isV2Configured: vi.fn().mockReturnValue(true),
        getV2Registration: vi.fn().mockResolvedValue({ status: 2, expiry: BigInt(FUTURE_EXPIRY), owner: OWNER }),
        getExpiry: vi.fn().mockResolvedValue(BigInt(LAPSED_EXPIRY)),
      },
    });
    await expect(svc.checkExpiry('fox.eth')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /batch-metadata expiry gate (app-level, through the Hono app)
// ---------------------------------------------------------------------------

const EXPIRED_NAME = 'expired-repro.eth';
const LIVE_NAME = 'live-repro.eth';
const EXPIRED_AT_SEC = Math.floor(Date.now() / 1000) - 10 * 86400; // 10 days ago
const LIVE_UNTIL_SEC = Math.floor(Date.now() / 1000) + 365 * 86400;

// Minimal in-memory KV (same shape the repo's app-level fakes use)
function makeKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  } as unknown as KVNamespace;
}

function cacheEntryFor(name: string): string {
  return JSON.stringify({
    metadata: {
      name,
      description: `${name}, an ENS name.`,
      image: `https://meta.test/sepolia/registry/${name}/image`,
      attributes: [{ trait_type: 'Migration Status', value: 'Migrated' }],
    },
    createdAt: Date.now() - 60_000, // fresh (age 60s < softTtl 24h) → pure KV hit, no origin fetch
    softTtl: 86400,
    migrationStatus: 'migrated',
  });
}

const env = {
  METADATA_CACHE: makeKv({
    [`meta:sepolia:registry:${EXPIRED_NAME}`]: cacheEntryFor(EXPIRED_NAME),
    [`meta:sepolia:registry:${LIVE_NAME}`]: cacheEntryFor(LIVE_NAME),
  }),
  SVG_CACHE: makeKv(),
  ASSET_BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} },
  DB: undefined,
  BIGNAME_MAINNET_URL: 'https://api.bigname.test',
  BIGNAME_SEPOLIA_URL: 'https://sepolia.api.bigname.test',
  MAINNET_RPC_URL: 'https://rpc-mainnet.test',
  SEPOLIA_RPC_URL: 'https://rpc-sepolia.test',
  RATE_LIMIT_DISABLED: 'true',
  LOG_LEVEL: 'error',
} as never;

const executionCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as ExecutionContext;

describe('/batch-metadata runs the same expiry gate as the single GET', () => {
  beforeAll(() => {
    // Both names are REGISTERED on v2 (status 2); one expiry is past, one future.
    // checkExpiry gates on exactly this state — no network, no other RPC reads.
    vi.spyOn(BlockchainService.prototype, 'isV2Configured').mockReturnValue(true);
    vi.spyOn(BlockchainService.prototype, 'getV2Registration').mockImplementation(
      async (_network, name) => ({
        status: 2,
        expiry: BigInt(name === EXPIRED_NAME ? EXPIRED_AT_SEC : LIVE_UNTIL_SEC),
        owner: OWNER,
      }),
    );
  });

  it('single GET /sepolia/registry/:name returns 410 despite a fresh KV cache entry', async () => {
    // regression: the KV metadata cache must never outrank the expiry gate.
    const res = await app.request(`/sepolia/registry/${EXPIRED_NAME}`, {}, env, executionCtx);
    expect(res.status).toBe(410);
  });

  it('POST /batch-metadata returns an error entry for the expired name instead of serving its KV hit', async () => {
    // regression: /batch-metadata bypassed checkExpiry, serving expired names from
    // the shared KV cache until hardTtl while the single GET 410'd them.
    const res = await app.request('/batch-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [EXPIRED_NAME, LIVE_NAME], network: 'sepolia' }),
    }, env, executionCtx);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      results: Array<{ name: string; metadata?: { name: string }; error?: string }>;
      total: number;
      successful: number;
      failed: number;
    };

    const expired = body.results.find(r => r.name === EXPIRED_NAME);
    expect(expired).toBeDefined();
    expect(expired!.metadata).toBeUndefined(); // NOT served from the KV hit
    expect(expired!.error).toContain('expired'); // DomainExpiredError → per-name error entry

    // The gate is per-name: the rest of the batch still succeeds.
    const live = body.results.find(r => r.name === LIVE_NAME);
    expect(live).toBeDefined();
    expect(live!.error).toBeUndefined();
    expect(live!.metadata?.name).toBe(LIVE_NAME);

    expect(body.total).toBe(2);
    expect(body.successful).toBe(1);
    expect(body.failed).toBe(1);
  });
});
