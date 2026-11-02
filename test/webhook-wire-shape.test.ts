import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

function makeCtx(body: string) {
  const raw = new Request('https://metadata.test/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
  return {
    req: {
      raw,
      header: (name: string) => raw.headers.get(name) ?? undefined,
    },
    json: (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }),
  } as any;
}

function makeFakes() {
  const cache = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  const svgCacheKv = {
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
    delete: vi.fn(async () => {}),
  };
  const metadataCacheKv = {
    delete: vi.fn(async () => {}),
  };
  const storageManager = {
    deleteByPrefix: vi.fn(async () => {}),
  };
  return { cache, svgCacheKv, metadataCacheKv, storageManager };
}

function makeUnauthenticatedService() {
  const fakes = makeFakes();
  const svc = new WebhookService(
    fakes.cache as any,
    { requireAuth: false, allowUnauthenticated: true },
    fakes.svgCacheKv as any,
    fakes.storageManager as any,
    fakes.metadataCacheKv as any,
  );
  return { svc, fakes };
}

function fullyShapedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2',
    name: 'red-team.eth',
    namehash: '0xabc',
    block_number: 1,
    tx_hash: '0xdef',
    log_index: 0,
    contract_address: '0x123',
    data: '{}',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function expectNoCacheInvalidation(fakes: ReturnType<typeof makeFakes>) {
  expect(fakes.cache.delete).not.toHaveBeenCalled();
  expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
  expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.svgCacheKv.list).not.toHaveBeenCalled();
  expect(fakes.svgCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.deleteByPrefix).not.toHaveBeenCalled();
}

describe('webhook wire-shape validation (W8-WEBHOOK-007)', () => {
  it('rejects a fully shaped unauthenticated-dev event for red-team.eth with data: false as 400 and does not invalidate caches', async () => {
    const { svc, fakes } = makeUnauthenticatedService();
    const body = JSON.stringify(fullyShapedEvent({ data: false }));
    const res = await svc.handleWebhook(makeCtx(body));

    expect(res.status).toBe(400);
    expectNoCacheInvalidation(fakes);
  });

  it('still accepts opaque string data, including empty, "{}", and a non-JSON string', async () => {
    for (const data of ['', '{}', 'not-json']) {
      const { svc, fakes } = makeUnauthenticatedService();
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(fullyShapedEvent({ data }))));
      expect(res.status).toBe(200);
      expect(fakes.cache.delete).toHaveBeenCalledTimes(6);
      expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('batch:', 'indexer');
    }
  });

  it('rejects other non-string data values with 400 and no cache invalidation', async () => {
    for (const data of [null, 1, { nested: true }, ['x']]) {
      const { svc, fakes } = makeUnauthenticatedService();
      const event = fullyShapedEvent();
      (event as any).data = data;
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(event)));
      expect(res.status).toBe(400);
      expectNoCacheInvalidation(fakes);
    }
  });

  it('rejects a missing data field with 400 and no cache invalidation', async () => {
    const { svc, fakes } = makeUnauthenticatedService();
    const event = fullyShapedEvent();
    delete (event as any).data;
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(event)));
    expect(res.status).toBe(400);
    expectNoCacheInvalidation(fakes);
  });

  it('rejects mistyped documented wire fields with 400 and no cache invalidation', async () => {
    const bad = [
      { protocol: 'v3' },
      { protocol: 2 },
      { block_number: '1' },
      { tx_hash: 0 },
      { log_index: '0' },
      { contract_address: 0 },
      { namehash: 1 },
      { name: 1 },
    ];
    for (const overrides of bad) {
      const { svc, fakes } = makeUnauthenticatedService();
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(fullyShapedEvent(overrides))));
      expect(res.status).toBe(400);
      expectNoCacheInvalidation(fakes);
    }
  });
});
