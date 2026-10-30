import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Minimal Hono Context double: only what WebhookService.handleWebhook reads.
function makeCtx(body: string) {
  const raw = new Request('https://metadata.test/webhook', {
    method: 'POST',
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
    list: vi.fn(async () => ({ keys: [{ name: 'svg:red-team.eth:migrated:518:518' }], list_complete: true })),
    delete: vi.fn(async () => {}),
  };
  const metadataCacheKv = {
    delete: vi.fn(async () => {}),
  };
  const storageManager = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  return { cache, svgCacheKv, metadataCacheKv, storageManager };
}

function makeService(fakes = makeFakes()) {
  const svc = new WebhookService(
    fakes.cache as any,
    { requireAuth: false, allowUnauthenticated: true },
    fakes.svgCacheKv as any,
    fakes.storageManager as any,
    fakes.metadataCacheKv as any,
  );
  return { svc, fakes };
}

// Minimized unauthenticated-dev event for red-team.eth (W8-WEBHOOK-004).
function minimizedEvent(overrides: Record<string, unknown> = {}) {
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
    timestamp: 1782217149,
    ...overrides,
  };
}

function expectNoCacheInvalidation(fakes: ReturnType<typeof makeFakes>) {
  expect(fakes.cache.delete).not.toHaveBeenCalled();
  expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
  expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.svgCacheKv.list).not.toHaveBeenCalled();
  expect(fakes.svgCacheKv.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.delete).not.toHaveBeenCalled();
  expect(fakes.storageManager.deleteByPrefix).not.toHaveBeenCalled();
}

async function expectLogIndexRejected(res: Response, fakes: ReturnType<typeof makeFakes>) {
  expect(res.status).toBe(400);
  const body = await res.json() as { error: string };
  expect(body.error).toMatch(/log_index/);
  expect(body.error).toMatch(/number/);
  expectNoCacheInvalidation(fakes);
}

describe('W8-WEBHOOK-004 log_index runtime validation', () => {
  it('rejects log_index: null with 400 and does not invalidate caches', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(minimizedEvent({ log_index: null }))));
    await expectLogIndexRejected(res, fakes);
  });

  it('rejects log_index as a string with 400 and does not invalidate caches', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(minimizedEvent({ log_index: '0' }))));
    await expectLogIndexRejected(res, fakes);
  });

  it('rejects a missing log_index with 400 and does not invalidate caches', async () => {
    const { svc, fakes } = makeService();
    const event = minimizedEvent();
    delete (event as { log_index?: number }).log_index;
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(event)));
    await expectLogIndexRejected(res, fakes);
  });

  it('accepts log_index: 0 and still invalidates caches', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(minimizedEvent({ log_index: 0 }))));
    expect(res.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalledTimes(6);
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('batch:', 'indexer');
    expect(fakes.metadataCacheKv.delete).toHaveBeenCalled();
    expect(fakes.svgCacheKv.list).toHaveBeenCalled();
    expect(fakes.storageManager.deleteByPrefix).toHaveBeenCalled();
  });
});
