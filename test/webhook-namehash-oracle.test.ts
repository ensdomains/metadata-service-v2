import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Blind acceptance check for W8-WEBHOOK-006. Hits the webhook handler, not a
// private validator: a fully shaped unauthenticated-dev event whose namehash
// is not a string or null must be rejected before any purge.

function makeCtx(body: string) {
  const raw = new Request('https://metadata.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
      }),
  } as any;
}

function makeService() {
  const cache = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  const metadataCacheKv = { delete: vi.fn(async () => {}) };
  const svc = new WebhookService(
    cache as any,
    { requireAuth: false, allowUnauthenticated: true },
    undefined,
    undefined,
    metadataCacheKv as any,
  );
  return { svc, cache, metadataCacheKv };
}

function event(namehash: unknown) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    contract_address: '0xdef',
    name: 'red-team.eth',
    namehash,
    data: '{}',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

describe('W8-WEBHOOK-006 namehash primitive shape', () => {
  it('rejects namehash: false before any cache invalidation', async () => {
    const { svc, cache, metadataCacheKv } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(event(false))));
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(String(body.error ?? '')).toMatch(/namehash/i);
    expect(cache.delete).not.toHaveBeenCalled();
    expect(cache.deleteByPrefix).not.toHaveBeenCalled();
    expect(metadataCacheKv.delete).not.toHaveBeenCalled();
  });

  it('still accepts a string or null namehash', async () => {
    for (const namehash of ['0x123', null]) {
      const { svc, cache } = makeService();
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(event(namehash))));
      expect(res.status).toBe(200);
      expect(cache.delete).toHaveBeenCalled();
    }
  });
});
