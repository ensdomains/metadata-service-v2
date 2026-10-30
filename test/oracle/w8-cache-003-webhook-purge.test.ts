import { describe, expect, it } from 'vitest';
import { WebhookService } from '../../src/services/webhook';

// Blind acceptance test for W8-CACHE-003. Drives the webhook handler, not a
// private helper: a valid NameRegistered delivery whose exact endpoint-metadata
// purge fails one key must not claim success.

const SECRET = '0'.repeat(64);
const NAME = 'red-team.eth';
const FAILED_KEY = 'meta:mainnet:registry:red-team.eth';
const EXACT_KEYS = [
  'meta:mainnet:registry:red-team.eth',
  'meta:mainnet:namewrapper:red-team.eth',
  'meta:sepolia:registry:red-team.eth',
  'meta:sepolia:namewrapper:red-team.eth',
] as const;

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

// KV double: the named key's delete rejects and the value stays. Every other
// exact metadata delete removes its value.
function makeMetadataKv() {
  const store = new Map<string, string>(EXACT_KEYS.map((key) => [key, 'stale']));
  return {
    store,
    delete: async (key: string) => {
      if (key === FAILED_KEY) {
        throw new Error(`delete rejected for ${key}`);
      }
      store.delete(key);
    },
  };
}

describe('W8-CACHE-003 webhook exact metadata purge', () => {
  it('fails the delivery with 500 when one exact metadata delete rejects', async () => {
    const metadataCacheKv = makeMetadataKv();
    const cache = {
      delete: async () => {},
      deleteByPrefix: async () => {},
    };
    const svgCacheKv = {
      list: async () => ({ keys: [] as { name: string }[] }),
      delete: async () => {},
    };
    const storageManager = {
      delete: async () => {},
      deleteByPrefix: async () => {},
    };
    const svc = new WebhookService(
      cache as any,
      { requireAuth: true, secret: SECRET },
      svgCacheKv as any,
      storageManager as any,
      metadataCacheKv as any,
    );

    const ts = Math.floor(Date.now() / 1000);
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
    const payload = await res.json() as { processed?: boolean; error?: string };

    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(500);
    expect(payload.processed).not.toBe(true);
    expect(metadataCacheKv.store.has(FAILED_KEY)).toBe(true);
    for (const key of EXACT_KEYS) {
      if (key === FAILED_KEY) continue;
      expect(metadataCacheKv.store.has(key)).toBe(false);
    }
  });
});
