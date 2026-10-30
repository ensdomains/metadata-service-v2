import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

const FAILED_KEY = 'meta:mainnet:registry:red-team.eth';
const EXACT_METADATA_KEYS = [
  FAILED_KEY,
  'meta:mainnet:namewrapper:red-team.eth',
  'meta:sepolia:registry:red-team.eth',
  'meta:sepolia:namewrapper:red-team.eth',
];

function makeContext(body: string) {
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
    json: (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as any;
}

describe('W8-CACHE-003 webhook metadata purge failure', () => {
  it('returns 500 and leaves the delivery retryable when one exact metadata delete fails', async () => {
    const storedKeys = new Set(EXACT_METADATA_KEYS);
    const metadataCacheKv = {
      delete: vi.fn(async (key: string) => {
        if (key === FAILED_KEY) throw new Error('simulated KV deletion failure');
        storedKeys.delete(key);
      }),
    };
    const cache = {
      delete: vi.fn(async () => {}),
      deleteByPrefix: vi.fn(async () => 0),
    };
    const service = new WebhookService(
      cache as any,
      { requireAuth: false, allowUnauthenticated: true },
      undefined,
      undefined,
      metadataCacheKv as any,
    );
    const event = {
      event_type: 'NameRegistered',
      protocol: 'v2',
      block_number: 100,
      tx_hash: '0xabc',
      log_index: 0,
      contract_address: '0xdef',
      name: 'red-team.eth',
      namehash: '0x123',
      data: '{}',
      timestamp: Math.floor(Date.now() / 1000),
    };

    const response = await service.handleWebhook(makeContext(JSON.stringify(event)));
    const body = await response.json() as Record<string, unknown>;

    expect.soft(response.status).toBe(500);
    expect.soft(body).not.toMatchObject({ processed: true });
    expect.soft(storedKeys.has(FAILED_KEY)).toBe(true);
    for (const key of EXACT_METADATA_KEYS.filter((candidate) => candidate !== FAILED_KEY)) {
      expect.soft(storedKeys.has(key), `${key} should be deleted`).toBe(false);
    }
    expect(metadataCacheKv.delete).toHaveBeenCalledTimes(4);
  });
});
