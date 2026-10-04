import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Blind acceptance test for W8-WEBHOOK-004. Hits the webhook handler, not a
// private validator. A fully shaped unauthenticated-dev event whose log_index
// is not a number must be rejected before any cache purge.

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

function fullyShaped(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function service(fakes: ReturnType<typeof makeFakes>) {
  return new WebhookService(
    fakes.cache as any,
    { requireAuth: false, allowUnauthenticated: true },
    fakes.svgCacheKv as any,
    fakes.storageManager as any,
    fakes.metadataCacheKv as any,
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

describe('W8-WEBHOOK-004 log_index is a number before cache invalidation', () => {
  it('rejects a fully shaped unauthenticated-dev event for red-team.eth with log_index null', async () => {
    const fakes = makeFakes();
    const res = await service(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped({ log_index: null }))),
    );

    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toMatch(/log_index/);
    expect(body).toMatch(/number/);
    expectNoInvalidation(fakes);
  });

  it('rejects a string log_index', async () => {
    const fakes = makeFakes();
    const res = await service(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped({ log_index: '0' }))),
    );

    expect(res.status).toBe(400);
    expectNoInvalidation(fakes);
  });

  it('rejects a missing log_index', async () => {
    const fakes = makeFakes();
    const event = fullyShaped();
    delete (event as { log_index?: unknown }).log_index;
    const res = await service(fakes).handleWebhook(makeCtx(JSON.stringify(event)));

    expect(res.status).toBe(400);
    expectNoInvalidation(fakes);
  });

  it('still invalidates when log_index is a number', async () => {
    const fakes = makeFakes();
    const res = await service(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped({ log_index: 0 }))),
    );

    expect(res.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalled();
  });
});
