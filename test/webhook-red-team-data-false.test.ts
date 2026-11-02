import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// Ticket interface: an unauthenticated-dev webhook for red-team.eth whose
// opaque `data` is not a string must be rejected before any cache purge.
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
      deleteByPrefix: vi.fn(async () => {}),
    },
  };
}

function fullyShaped(data: unknown) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    contract_address: '0xdef',
    name: 'red-team.eth',
    namehash: '0x123',
    data,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeService(fakes: ReturnType<typeof makeFakes>) {
  return new WebhookService(
    fakes.cache as any,
    { requireAuth: false, allowUnauthenticated: true },
    fakes.svgCacheKv as any,
    fakes.storageManager as any,
    fakes.metadataCacheKv as any,
  );
}

describe('webhook data must be a string before cache invalidation', () => {
  it('rejects a fully shaped unauthenticated-dev event for red-team.eth with data false', async () => {
    const fakes = makeFakes();
    const res = await makeService(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped(false))),
    );

    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
    expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
    expect(fakes.svgCacheKv.delete).not.toHaveBeenCalled();
    expect(fakes.storageManager.deleteByPrefix).not.toHaveBeenCalled();
  });

  it('still accepts opaque string data and invalidates caches', async () => {
    const fakes = makeFakes();
    const res = await makeService(fakes).handleWebhook(
      makeCtx(JSON.stringify(fullyShaped('{}'))),
    );

    expect(res.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('batch:', 'indexer');
  });
});
