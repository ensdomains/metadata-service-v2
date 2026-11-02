import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// W8-CACHE-003: a valid NameRegistered webhook must not claim a completed purge
// when one exact endpoint-metadata delete rejects. The other three exact keys
// must still be deleted; the rejected key must remain so a later delivery can
// retry it.

const NAME = 'red-team.eth';
const REJECTED_KEY = `meta:mainnet:registry:${NAME}`;
const SUCCEEDING_KEYS = [
  `meta:mainnet:namewrapper:${NAME}`,
  `meta:sepolia:registry:${NAME}`,
  `meta:sepolia:namewrapper:${NAME}`,
] as const;
const EXACT_METADATA_KEYS = [REJECTED_KEY, ...SUCCEEDING_KEYS] as const;

function makeCtx(body: string) {
  const raw = new Request('https://metadata.test/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

function makeMetadataKv() {
  const store = new Map<string, string>(
    EXACT_METADATA_KEYS.map((key) => [key, 'stale-metadata']),
  );
  return {
    store,
    delete: vi.fn(async (key: string) => {
      if (key === REJECTED_KEY) {
        return Promise.reject(new Error('KV delete rejected'));
      }
      store.delete(key);
    }),
  };
}

describe('W8-CACHE-003 webhook exact metadata purge', () => {
  it('returns 500 and does not claim a completed purge when one exact metadata delete rejects', async () => {
    const metadataCacheKv = makeMetadataKv();
    const cache = {
      delete: vi.fn(async () => {}),
      deleteByPrefix: vi.fn(async () => {}),
    };
    const svgCacheKv = {
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
      delete: vi.fn(async () => {}),
    };
    const storageManager = {
      deleteByPrefix: vi.fn(async () => {}),
    };

    const svc = new WebhookService(
      cache as any,
      { requireAuth: false, allowUnauthenticated: true },
      svgCacheKv as any,
      storageManager as any,
      metadataCacheKv as any,
    );

    const body = JSON.stringify({
      event_type: 'NameRegistered',
      protocol: 'v2',
      block_number: 1,
      tx_hash: '0x1',
      log_index: 0,
      contract_address: '0x2',
      name: NAME,
      namehash: '0x3',
      data: '{}',
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await svc.handleWebhook(makeCtx(body));
    const payload = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(500);
    expect(payload.processed).not.toBe(true);
    expect(metadataCacheKv.store.has(REJECTED_KEY)).toBe(true);
    for (const key of SUCCEEDING_KEYS) {
      expect(metadataCacheKv.store.has(key)).toBe(false);
    }
    expect(metadataCacheKv.delete).toHaveBeenCalledWith(REJECTED_KEY);
    for (const key of SUCCEEDING_KEYS) {
      expect(metadataCacheKv.delete).toHaveBeenCalledWith(key);
    }
  });
});
