import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Blind acceptance for W8-WEBHOOK-005. Drives the webhook handler, not a
// private validator. A fully shaped unauthenticated-dev event for red-team.eth
// with contract_address set to the number 0 must be rejected before any purge.

function makeCtx(body: string) {
  const raw = new Request('https://metadata.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return {
    req: {
      raw,
      text: () => raw.text(),
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
      list: vi.fn(async () => ({ keys: [] })),
      delete: vi.fn(async () => {}),
    },
    metadataCacheKv: {
      list: vi.fn(async () => ({ keys: [] })),
      delete: vi.fn(async () => {}),
    },
    storageManager: {
      delete: vi.fn(async () => {}),
      deleteByPrefix: vi.fn(async () => {}),
    },
  };
}

function shapedEvent(contractAddress: unknown) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    contract_address: contractAddress,
    name: 'red-team.eth',
    namehash: '0x123',
    data: '{}',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function noInvalidation(fakes: ReturnType<typeof makeFakes>) {
  expect(fakes.cache.delete).not.toHaveBeenCalled();
  expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
  expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.svgCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.deleteByPrefix).not.toHaveBeenCalled();
}

describe('W8-WEBHOOK-005 contract_address primitive', () => {
  it('rejects contract_address: 0 with 400 and does not invalidate', async () => {
    const fakes = makeFakes();
    const svc = new WebhookService(
      fakes.cache as any,
      { requireAuth: false, allowUnauthenticated: true },
      fakes.svgCacheKv as any,
      fakes.storageManager as any,
      fakes.metadataCacheKv as any,
    );
    const res = await svc.handleWebhook(
      makeCtx(JSON.stringify(shapedEvent(0))),
    );
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(String(body.error)).toMatch(/contract_address/i);
    expect(String(body.error)).toMatch(/string/i);
    noInvalidation(fakes);
  });

  it('still accepts a string contract_address and invalidates', async () => {
    const fakes = makeFakes();
    const svc = new WebhookService(
      fakes.cache as any,
      { requireAuth: false, allowUnauthenticated: true },
      fakes.svgCacheKv as any,
      fakes.storageManager as any,
      fakes.metadataCacheKv as any,
    );
    const res = await svc.handleWebhook(
      makeCtx(JSON.stringify(shapedEvent('0xdef'))),
    );

    expect(res.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalled();
  });
});
