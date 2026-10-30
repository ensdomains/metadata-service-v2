import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../../src/services/webhook';

// Blind acceptance test for W8-WEBHOOK-009. Drives the webhook handler with the
// minimized input: a validly signed envelope 121 seconds old and toleranceSecs
// NaN. The default 120-second window must still reject it before purge.

const SECRET = '0'.repeat(64);
const NAME = 'stale-window.eth';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function sign(secretHex: string, ts: number, body: string): Promise<string> {
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
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

function makeCtx(body: string, headers: Record<string, string>) {
  const raw = new Request('https://metadata.test/webhook', {
    method: 'POST',
    headers,
    body,
  });
  return {
    req: {
      raw,
      header: (name: string) => raw.headers.get(name) ?? undefined,
    },
    json: (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as any;
}

function makeFakes() {
  return {
    cache: {
      delete: vi.fn(async () => {}),
      deleteByPrefix: vi.fn(async () => {}),
    },
    svgCacheKv: {
      list: vi.fn(async () => ({ keys: [] as { name: string }[] })),
      delete: vi.fn(async () => {}),
    },
    metadataCacheKv: {
      delete: vi.fn(async () => {}),
    },
    storageManager: {
      delete: vi.fn(async () => {}),
      deleteByPrefix: vi.fn(async () => {}),
    },
  };
}

describe('W8-WEBHOOK-009 non-finite replay tolerance', () => {
  it('rejects a 121-second-old signed envelope when toleranceSecs is NaN, before purge', async () => {
    const fakes = makeFakes();
    const svc = new WebhookService(
      fakes.cache as any,
      { requireAuth: true, secret: SECRET, toleranceSecs: NaN },
      fakes.svgCacheKv as any,
      fakes.storageManager as any,
      fakes.metadataCacheKv as any,
    );

    const ts = Math.floor(Date.now() / 1000) - 121;
    const body = JSON.stringify({
      event_type: 'NameRegistered',
      protocol: 'v1',
      block_number: 100,
      tx_hash: '0xabc',
      log_index: 0,
      contract_address: '0xdef',
      name: NAME,
      namehash: '0x123',
      data: '{}',
      timestamp: ts,
    });
    const res = await svc.handleWebhook(makeCtx(body, {
      'X-Webhook-Signature': await sign(SECRET, ts, body),
      'X-Webhook-Timestamp': String(ts),
      'Content-Type': 'application/json',
    }));

    expect({
      status: res.status,
      deletes: fakes.cache.delete.mock.calls.length,
      batchDeletes: fakes.cache.deleteByPrefix.mock.calls.length,
      metadataDeletes: fakes.metadataCacheKv.delete.mock.calls.length,
      storageDeletes: fakes.storageManager.deleteByPrefix.mock.calls.length,
    }).toEqual({
      status: 401,
      deletes: 0,
      batchDeletes: 0,
      metadataDeletes: 0,
      storageDeletes: 0,
    });
  });
});
