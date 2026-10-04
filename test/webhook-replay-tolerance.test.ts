import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Spies on per-network warm/persist path — set up before dynamic app import.
// vi.mock factories are hoisted above imports and replace the real classes.
const warmSpies = vi.hoisted(() => ({
  resolveStatusForImage: vi.fn().mockResolvedValue('unmigrated'),
  recordMigrationStatus: vi.fn().mockResolvedValue(undefined),
  getImage: vi.fn().mockResolvedValue({ svg: '<svg></svg>', contentType: 'image/svg+xml', cacheStatus: 'miss', ttlConfig: { softTtl: 300, hardTtl: 3600 }, avatarFailed: false }),
}));

vi.mock('../src/services/metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/metadata')>();
  return {
    ...actual,
    MetadataService: class extends actual.MetadataService {
      async resolveStatusForImage(...args: any[]) {
        warmSpies.resolveStatusForImage(...args as [any, any, any?]);
        return 'unmigrated' as any;
      }
      async recordMigrationStatus(...args: any[]) {
        warmSpies.recordMigrationStatus(...args as [any, any]);
        return undefined as any;
      }
    },
  };
});

vi.mock('../src/services/image-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image-cache')>();
  return {
    ...actual,
    ImageCacheService: class extends actual.ImageCacheService {
      async getImage(...args: any[]) {
        warmSpies.getImage(...args as [any, any, any]);
        return { svg: '<svg></svg>', contentType: 'image/svg+xml', cacheStatus: 'miss', ttlConfig: { softTtl: 300, hardTtl: 3600 }, avatarFailed: false } as any;
      }
    },
  };
});

const SECRET = '0'.repeat(64);
const NOW_SECS = 1_800_000_000;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

async function sign(timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(SECRET) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`) as BufferSource,
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

function event(timestamp: number) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    contract_address: '0xdef',
    name: 'stale-window.eth',
    namehash: '0x123',
    data: '{}',
    timestamp,
  };
}

async function signedContext(timestamp: number) {
  const body = JSON.stringify(event(timestamp));
  const request = new Request('https://metadata.test/webhook', {
    method: 'POST',
    headers: {
      'X-Webhook-Timestamp': String(timestamp),
      'X-Webhook-Signature': await sign(timestamp, body),
    },
    body,
  });
  return {
    req: {
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    json: (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as any;
}

function makeService(toleranceSecs: number) {
  const cache = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  const svgCache = {
    list: vi.fn(async () => ({
      keys: [{ name: 'svg:stale-window.eth:native:518:518' }],
      list_complete: true,
    })),
    delete: vi.fn(async () => {}),
  };
  const metadataCache = {
    delete: vi.fn(async () => {}),
  };
  const storage = {
    deleteByPrefix: vi.fn(async () => {}),
  };
  const service = new WebhookService(
    cache as any,
    { requireAuth: true, secret: SECRET, toleranceSecs },
    svgCache as any,
    storage as any,
    metadataCache as any,
  );
  return { service, cache, svgCache, metadataCache, storage };
}

function expectNoPurge(fakes: ReturnType<typeof makeService>) {
  expect.soft(fakes.cache.delete).not.toHaveBeenCalled();
  expect.soft(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
  expect.soft(fakes.svgCache.list).not.toHaveBeenCalled();
  expect.soft(fakes.svgCache.delete).not.toHaveBeenCalled();
  expect.soft(fakes.metadataCache.delete).not.toHaveBeenCalled();
  expect.soft(fakes.storage.deleteByPrefix).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('webhook replay tolerance configuration', () => {
  it('falls back to 120 seconds for NaN and rejects a signed envelope 121 seconds old before purging', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SECS * 1000);
    const fakes = makeService(Number.NaN);

    const response = await fakes.service.handleWebhook(await signedContext(NOW_SECS - 121));

    expect.soft(response.status).toBe(401);
    expectNoPurge(fakes);
  });

  it('still accepts and purges a fresh signed envelope when tolerance is NaN', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SECS * 1000);
    const fakes = makeService(Number.NaN);

    const response = await fakes.service.handleWebhook(await signedContext(NOW_SECS));

    expect(response.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalledTimes(6);
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('batch:', 'indexer');
    expect(fakes.metadataCache.delete).toHaveBeenCalledTimes(4);
    expect(fakes.svgCache.list).toHaveBeenCalledTimes(1);
    expect(fakes.svgCache.delete).toHaveBeenCalledTimes(1);
    expect(fakes.storage.deleteByPrefix).toHaveBeenCalledTimes(2);
  });

  it('continues to honor a finite override', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SECS * 1000);
    const accepted = makeService(300);
    const rejected = makeService(300);

    const acceptedResponse = await accepted.service.handleWebhook(
      await signedContext(NOW_SECS - 121),
    );
    const rejectedResponse = await rejected.service.handleWebhook(
      await signedContext(NOW_SECS - 1000),
    );

    expect(acceptedResponse.status).toBe(200);
    expect(accepted.cache.delete).toHaveBeenCalledTimes(6);
    expect(rejectedResponse.status).toBe(401);
    expectNoPurge(rejected);
  });
});

// ── public POST /webhook route tests ──────────────────────────────────────

describe('webhook replay tolerance via public POST /webhook route', () => {
  const SECRET_HEX = '0'.repeat(64);
  const NAME = 'stale-window.eth';

  beforeEach(() => {
    warmSpies.resolveStatusForImage.mockClear();
    warmSpies.recordMigrationStatus.mockClear();
    warmSpies.getImage.mockClear();
  });

  async function loadApp() {
    vi.resetModules();
    return (await import('../src/index')).default;
  }

  async function signBody(ts: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(SECRET_HEX) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'HMAC', key,
      new TextEncoder().encode(`${ts}.${body}`) as BufferSource,
    );
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `sha256=${hex}`;
  }

  const BATCH_PFX = 'indexer:batch:';
  const BATCH_KEY = 'indexer:batch:recent-names';
  const SVG_PFX = `svg:${NAME}:`;
  const SVG_KEY = `svg:${NAME}:native:518:518`;
  const AVATAR_PFX = `avatars/${NAME}:`;
  const AVATAR_KEY = `avatars/${NAME}:mainnet`;
  const SVG_R2_PFX = `svg/svg:${NAME}:`;
  const SVG_R2_KEY = `svg/svg:${NAME}:518:518`;

  const INTERNAL_KEYS = [
    `indexer:ensnode:mainnet:domain:${NAME}`,
    `indexer:ensnode:mainnet:migration:${NAME}`,
    `indexer:ensnode:mainnet:hierarchy:${NAME}`,
    `indexer:ensnode:sepolia:domain:${NAME}`,
    `indexer:ensnode:sepolia:migration:${NAME}`,
    `indexer:ensnode:sepolia:hierarchy:${NAME}`,
  ];
  const META_KEYS = [
    `meta:mainnet:registry:${NAME}`,
    `meta:mainnet:namewrapper:${NAME}`,
    `meta:sepolia:registry:${NAME}`,
    `meta:sepolia:namewrapper:${NAME}`,
  ];

  function makeFakesAndEnv(overrides: Record<string, unknown>) {
    const metadataList = vi.fn(async (args: { prefix?: string }) => {
      if (args?.prefix === BATCH_PFX) {
        return { keys: [{ name: BATCH_KEY }], list_complete: true };
      }
      return { keys: [] as { name: string }[], list_complete: true };
    });
    const metadataKv = {
      delete: vi.fn(async () => {}),
      list: metadataList,
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    };
    const svgList = vi.fn(async (args: { prefix?: string }) => {
      if (args?.prefix === SVG_PFX) {
        return { keys: [{ name: SVG_KEY }], list_complete: true };
      }
      return { keys: [] as { name: string }[], list_complete: true };
    });
    const svgKv = {
      delete: vi.fn(async () => {}),
      list: svgList,
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    };
    const r2List = vi.fn(async (args: { prefix?: string }) => {
      const pfx = args?.prefix ?? '';
      if (pfx === AVATAR_PFX) {
        return { objects: [{ key: AVATAR_KEY }], truncated: false, cursor: undefined };
      }
      if (pfx === SVG_R2_PFX) {
        return { objects: [{ key: SVG_R2_KEY }], truncated: false, cursor: undefined };
      }
      return { objects: [] as { key: string }[], truncated: false, cursor: undefined };
    });
    const r2 = {
      delete: vi.fn(async () => {}),
      list: r2List,
      get: vi.fn(async () => null),
      put: vi.fn(async () => ({ key: '', etag: '', size: 0, httpMetadata: {} })),
      head: vi.fn(async () => null),
    };
    const env = {
      METADATA_CACHE: metadataKv,
      SVG_CACHE: svgKv,
      ASSET_BUCKET: r2,
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [], success: true })),
            run: vi.fn(async () => ({ success: true })),
          })),
        })),
        batch: vi.fn(),
      },
      ENSNODE_MAINNET_URL: 'https://api.ensnode.test/graphql',
      ENSNODE_SEPOLIA_V2_URL: 'https://api.sepolia.ensnode.test/graphql',
      MAINNET_RPC_URL: 'https://mainnet.test.rpc',
      SEPOLIA_RPC_URL: 'https://sepolia.test.rpc',
      LOG_LEVEL: 'error',
      RATE_LIMIT_DISABLED: 'true',
      ...overrides,
    } as unknown as Record<string, unknown>;
    return { env, mocks: { metadataKv, svgKv, r2 } };
  }

  function makeBody(ts: number) {
    return JSON.stringify({
      event_type: 'NameRegistered',
      protocol: 'v2',
      block_number: 100,
      tx_hash: '0xabc',
      log_index: 0,
      contract_address: '0xdef',
      name: NAME,
      namehash: '0x123',
      data: '{}',
      timestamp: ts,
    });
  }

  async function postWebhook(
    app: Awaited<ReturnType<typeof loadApp>>,
    env: Record<string, unknown>,
    ts: number,
  ) {
    const body = makeBody(ts);
    const sig = await signBody(ts, body);
    const bg: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { bg.push(p); },
      passThroughOnException: vi.fn(),
    };
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(ts),
        'X-Webhook-Signature': sig,
      },
      body,
    }, env, ctx as unknown as ExecutionContext);
    return { res, bg };
  }

  type Mocks = ReturnType<typeof makeFakesAndEnv>['mocks'];

  function assertNoPurge(mocks: Mocks) {
    expect.soft(mocks.metadataKv.delete).not.toHaveBeenCalled();
    expect.soft(mocks.metadataKv.list).not.toHaveBeenCalled();
    expect.soft(mocks.svgKv.delete).not.toHaveBeenCalled();
    expect.soft(mocks.svgKv.list).not.toHaveBeenCalled();
    expect.soft(mocks.r2.delete).not.toHaveBeenCalled();
    expect.soft(mocks.r2.list).not.toHaveBeenCalled();
  }

  function assertFullPurge(mocks: Mocks) {
    expect.soft(mocks.metadataKv.delete).toHaveBeenCalledTimes(11);
    for (const k of INTERNAL_KEYS) {
      expect.soft(mocks.metadataKv.delete).toHaveBeenCalledWith(k);
    }
    for (const k of META_KEYS) {
      expect.soft(mocks.metadataKv.delete).toHaveBeenCalledWith(k);
    }
    expect.soft(mocks.metadataKv.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: BATCH_PFX }),
    );
    expect.soft(mocks.metadataKv.delete).toHaveBeenCalledWith(BATCH_KEY);
    expect.soft(mocks.svgKv.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: SVG_PFX }),
    );
    expect.soft(mocks.svgKv.delete).toHaveBeenCalledWith(SVG_KEY);
    expect.soft(mocks.r2.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: AVATAR_PFX }),
    );
    expect.soft(mocks.r2.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: SVG_R2_PFX }),
    );
    expect.soft(mocks.r2.delete).toHaveBeenCalledWith(AVATAR_KEY);
    expect.soft(mocks.r2.delete).toHaveBeenCalledWith(SVG_R2_KEY);
  }

  // ── stale-envelope rejection tests ────────────────────────────────────

  it('300junk-garbage tolerance: rejects 121s-old, zero purge, zero bg work, zero edge purge', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '300junk',
    });
    const edgePurge = vi.fn(async () => true);
    vi.stubGlobal('caches', { default: { delete: edgePurge, put: vi.fn(), match: vi.fn() } });
    const app = await loadApp();
    const { res, bg } = await postWebhook(app, env, nowSecs - 121);

    expect.soft(res.status).toBe(401);
    assertNoPurge(mocks);
    expect.soft(bg).toHaveLength(0);
    expect.soft(edgePurge).not.toHaveBeenCalled();
    assertNoWarm();
  });

  it('86401 above-max tolerance: rejects 121s-old, zero purge, zero bg work, zero edge purge, zero warm', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '86401',
    });
    const edgePurge = vi.fn(async () => true);
    vi.stubGlobal('caches', { default: { delete: edgePurge, put: vi.fn(), match: vi.fn() } });
    const app = await loadApp();
    const { res, bg } = await postWebhook(app, env, nowSecs - 121);

    expect.soft(res.status).toBe(401);
    assertNoPurge(mocks);
    expect.soft(bg).toHaveLength(0);
    expect.soft(edgePurge).not.toHaveBeenCalled();
    assertNoWarm();
  });

  it('positive digit-only huge tolerance: rejects 121s-old, zero purge, zero bg work, zero edge purge, zero warm', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '999999999999999999999',
    });
    const edgePurge = vi.fn(async () => true);
    vi.stubGlobal('caches', { default: { delete: edgePurge, put: vi.fn(), match: vi.fn() } });
    const app = await loadApp();
    const { res, bg } = await postWebhook(app, env, nowSecs - 121);

    expect.soft(res.status).toBe(401);
    assertNoPurge(mocks);
    expect.soft(bg).toHaveLength(0);
    expect.soft(edgePurge).not.toHaveBeenCalled();
    assertNoWarm();
  });

  // ── acceptance tests ──────────────────────────────────────────────────

  function assertEdgePurge(edgePurge: ReturnType<typeof vi.fn>, name: string) {
    // Purges all SUPPORTED_NETWORKS × {registry,namewrapper} × {image,rasterize}
    // origin is derived from c.req.url (http://localhost in app.request tests)
    expect.soft(edgePurge).toHaveBeenCalledTimes(8);
    const urls = edgePurge.mock.calls.map((c: any) => (c[0] as Request).url);
    for (const net of ['mainnet', 'sepolia']) {
      for (const rt of ['registry', 'namewrapper']) {
        for (const kind of ['image', 'rasterize']) {
          expect.soft(urls).toContain(
            `http://localhost/${net}/${rt}/${name}/${kind}`,
          );
        }
      }
    }
    expect.soft(urls.every((u: string) => u.includes(name))).toBe(true);
  }

  function assertNoWarm() {
    expect.soft(warmSpies.resolveStatusForImage).not.toHaveBeenCalled();
    expect.soft(warmSpies.recordMigrationStatus).not.toHaveBeenCalled();
    expect.soft(warmSpies.getImage).not.toHaveBeenCalled();
  }

  function assertWarm(name: string) {
    // v2 protocol → targetNetworks = networks with indexerV2ApiVersion='v2'.
    // In production config only sepolia qualifies; mainnet is v1.
    const nets = ['sepolia'];
    for (const net of nets) {
      expect.soft(warmSpies.resolveStatusForImage)
        .toHaveBeenCalledWith(net, name, { strict: true });
      expect.soft(warmSpies.recordMigrationStatus)
        .toHaveBeenCalledWith(name, 'unmigrated');
      expect.soft(warmSpies.getImage)
        .toHaveBeenCalledWith(name, expect.objectContaining({ name, migrationStatus: 'unmigrated' }), expect.any(Object));
    }
    expect.soft(warmSpies.resolveStatusForImage).toHaveBeenCalledTimes(1);
    expect.soft(warmSpies.recordMigrationStatus).toHaveBeenCalledTimes(1);
    expect.soft(warmSpies.getImage).toHaveBeenCalledTimes(1);
  }

  it('86400 inclusive max: accepts age 121, full purge, bg drained, exact edge purge URLs', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '86400',
    });
    const edgePurge = vi.fn(async () => true);
    vi.stubGlobal('caches', { default: { delete: edgePurge, put: vi.fn(), match: vi.fn() } });
    const app = await loadApp();
    const { res, bg } = await postWebhook(app, env, nowSecs - 121);

    expect.soft(res.status).toBe(200);
    assertFullPurge(mocks);
    expect.soft(bg.length).toBeGreaterThanOrEqual(1);
    const settled = await Promise.allSettled(bg);
    expect.soft(settled.every(s => s.status === 'fulfilled')).toBe(true);
    assertEdgePurge(edgePurge, NAME);
    assertWarm(NAME);
  });

  it('negative unsafe-int fallback: accepts fresh, full purge, bg drained, exact edge purge URLs, warm/persist', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '-9007199254740993',
    });
    const edgePurge = vi.fn(async () => true);
    vi.stubGlobal('caches', { default: { delete: edgePurge, put: vi.fn(), match: vi.fn() } });
    const app = await loadApp();
    const { res, bg } = await postWebhook(app, env, nowSecs);

    expect.soft(res.status).toBe(200);
    assertFullPurge(mocks);
    expect.soft(bg.length).toBeGreaterThanOrEqual(1);
    const settled = await Promise.allSettled(bg);
    expect.soft(settled.every(s => s.status === 'fulfilled')).toBe(true);
    assertEdgePurge(edgePurge, NAME);
    assertWarm(NAME);
  });
});