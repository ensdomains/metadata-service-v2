import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

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

describe('webhook replay tolerance via public POST /webhook route', () => {
  const SECRET_HEX = '0'.repeat(64);

  async function loadApp() {
    vi.resetModules();
    return (await import('../src/index')).default;
  }

  async function signBody(secretHex: string, ts: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(secretHex) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${ts}.${body}`) as BufferSource,
    );
    const hex = [...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256=${hex}`;
  }

  function makeFakesAndEnv(overrides: Record<string, unknown>) {
    const metadataKv = {
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [] as { name: string }[], list_complete: true })),
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    };
    const svgKv = {
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [] as { name: string }[], list_complete: true })),
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    };
    const r2 = {
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ objects: [] as { key: string }[], truncated: false, cursor: undefined })),
      get: vi.fn(async () => null),
      put: vi.fn(async () => ({ key: '', etag: '', size: 0, httpMetadata: {} })),
      head: vi.fn(async () => null),
    };
    const env = {
      METADATA_CACHE: metadataKv,
      SVG_CACHE: svgKv,
      ASSET_BUCKET: r2,
      DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => null), all: vi.fn(async () => ({ results: [], success: true })), run: vi.fn(async () => ({ success: true })) })) })), batch: vi.fn() },
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
      name: 'stale-window.eth',
      namehash: '0x123',
      data: '{}',
      timestamp: ts,
    });
  }

  function assertNoPurge(mocks: ReturnType<typeof makeFakesAndEnv>['mocks']) {
    expect.soft(mocks.metadataKv.delete).not.toHaveBeenCalled();
    expect.soft(mocks.metadataKv.list).not.toHaveBeenCalled();
    expect.soft(mocks.svgKv.delete).not.toHaveBeenCalled();
    expect.soft(mocks.svgKv.list).not.toHaveBeenCalled();
    expect.soft(mocks.r2.delete).not.toHaveBeenCalled();
    expect.soft(mocks.r2.list).not.toHaveBeenCalled();
  }

  it('rejects a 121s-old signed envelope when WEBHOOK_TOLERANCE_SECS has a garbage suffix that parseInt would accept', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const ts = nowSecs - 121;
    const body = makeBody(ts);
    const sig = await signBody(SECRET_HEX, ts, body);

    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '300junk',
    });
    const app = await loadApp();

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(ts),
        'X-Webhook-Signature': sig,
      },
      body,
    }, env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);

    expect.soft(res.status).toBe(401);
    assertNoPurge(mocks);
  });

  it('rejects a 121s-old signed envelope when WEBHOOK_TOLERANCE_SECS is one above the maximum accepted tolerance', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const ts = nowSecs - 121;
    const body = makeBody(ts);
    const sig = await signBody(SECRET_HEX, ts, body);

    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '86401',
    });
    const app = await loadApp();

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(ts),
        'X-Webhook-Signature': sig,
      },
      body,
    }, env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);

    expect.soft(res.status).toBe(401);
    assertNoPurge(mocks);
  });

  it('accepts and executes every purge path for a fresh correctly-signed envelope whose toleranceSecs falls back to the 120s default', async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const ts = nowSecs;
    const body = makeBody(ts);
    const sig = await signBody(SECRET_HEX, ts, body);

    const { env, mocks } = makeFakesAndEnv({
      WEBHOOK_SECRET: SECRET_HEX,
      WEBHOOK_TOLERANCE_SECS: '-9007199254740993',
    });
    mocks.svgKv.list.mockResolvedValue({
      keys: [{ name: 'svg:stale-window.eth:native:518:518' }],
      list_complete: true,
    });
    mocks.r2.list.mockResolvedValue({
      objects: [{ key: 'avatars/stale-window.eth:mainnet' }],
      truncated: false,
      cursor: undefined,
    });
    const app = await loadApp();

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(ts),
        'X-Webhook-Signature': sig,
      },
      body,
    }, env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);

    expect.soft(res.status).toBe(200);
    expect.soft(mocks.metadataKv.delete).toHaveBeenCalledTimes(10);
    expect.soft(mocks.metadataKv.list).toHaveBeenCalledTimes(1);
    expect.soft(mocks.svgKv.list).toHaveBeenCalledTimes(1);
    expect.soft(mocks.svgKv.delete).toHaveBeenCalledTimes(1);
    expect.soft(mocks.r2.list).toHaveBeenCalledTimes(2);
    expect.soft(mocks.r2.delete).toHaveBeenCalledTimes(2);
  });
});
