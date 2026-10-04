import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

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
      list: vi.fn(async () => ({ keys: [{ name: 'svg:red-team.eth:migrated:518:518' }] })),
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

function fullyShapedEvent(contractAddress: unknown) {
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

describe('W8-WEBHOOK-005 contract_address', () => {
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
      makeCtx(JSON.stringify(fullyShapedEvent(0))),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('contract_address');
    expect(body.error).toContain('string');
    expect(body.error).toMatch(/required to be a string/);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
    expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
    expect(fakes.svgCacheKv.list).not.toHaveBeenCalled();
    expect(fakes.svgCacheKv.delete).not.toHaveBeenCalled();
    expect(fakes.storageManager.delete).not.toHaveBeenCalled();
    expect(fakes.storageManager.deleteByPrefix).not.toHaveBeenCalled();
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
      makeCtx(JSON.stringify(fullyShapedEvent('0xdef'))),
    );

    expect(res.status).toBe(200);
    expect(fakes.cache.delete).toHaveBeenCalledTimes(6);
    expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('batch:', 'indexer');
  });
});
