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
