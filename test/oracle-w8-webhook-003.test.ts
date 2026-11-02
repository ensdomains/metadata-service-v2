import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Blind oracle for WEB-1696 / W8-WEBHOOK-003. Drives the public webhook handler
// the POST /webhook route uses. Not a lane's test: do not treat this file as
// the focused regression the workhorse spec names.

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

function makeFakes() {
  return {
    cache: {
      delete: vi.fn(async () => {}),
      deleteByPrefix: vi.fn(async () => {}),
    },
    svgCacheKv: {
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
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

// Fully shaped unauthenticated-dev event. Every documented field is present
// and valid except the tx_hash under test.
function fullyShaped(txHash: unknown) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2' as const,
    block_number: 100,
    tx_hash: txHash,
    log_index: 0,
    contract_address: '0xdef',
    name: 'red-team.eth',
    namehash: '0x123',
    data: '{}',
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function service(fakes: ReturnType<typeof makeFakes>) {
  return new WebhookService(
    fakes.cache as never,
    { requireAuth: false, allowUnauthenticated: true },
    fakes.svgCacheKv as never,
    fakes.storageManager as never,
    fakes.metadataCacheKv as never,
  );
}

function expectNoInvalidation(fakes: ReturnType<typeof makeFakes>) {
  expect(fakes.cache.delete).not.toHaveBeenCalled();
  expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
  expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.svgCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.deleteByPrefix).not.toHaveBeenCalled();
}

describe('oracle W8-WEBHOOK-003: tx_hash must be a string before purge', () => {
  it('rejects a fully shaped unauthenticated-dev event for red-team.eth with tx_hash null', async () => {
    const fakes = makeFakes();
    const res = await service(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped(null))),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: unknown };
    expect(body.error).toEqual('tx_hash must be a string');
    expectNoInvalidation(fakes);
  });

  it('still purges when the same event has a string tx_hash', async () => {
    const fakes = makeFakes();
    const res = await service(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped('0xabc'))),
    );

    expect(res.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalled();
  });
});
