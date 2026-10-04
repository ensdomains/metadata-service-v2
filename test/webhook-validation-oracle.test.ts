// Oracle (blind): interface-level test for W8-WEBHOOK-002 written before
// any lane's diff was read. Tests at the ticket's own interface — the webhook
// handler — not the internal validatePayload shape the lanes choose.
//
// Invariant: webhook event identity fields must be runtime-validated against
// their documented primitive shapes before any cache invalidation side effect
// runs. The handler must reject (400) a payload where a field the EnsNameEvent
// interface declares with a primitive type has the wrong type at runtime, and
// it must never invalidate caches on a rejected payload.
import { describe, it, expect, vi } from 'vitest';
import { WebhookService } from '../src/services/webhook';

// --- helpers (minimal copy of the test harness, independent of the lanes) ---

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
    json: (obj: any, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }),
  } as any;
}

function makeFakes() {
  const cache = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  return { cache };
}

function makeService(config: any = { requireAuth: false, allowUnauthenticated: true }) {
  const fakes = makeFakes();
  const svc = new WebhookService(fakes.cache as any, config);
  return { svc, fakes };
}

function validEvent(overrides: Record<string, any> = {}) {
  return {
    event_type: 'NameRegistered',
    protocol: 'v2',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    contract_address: '0xdef',
    name: 'vitalik.eth',
    namehash: '0x123',
    data: '{}',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('W8-WEBHOOK-002 oracle: identity field type validation at handler level', () => {
  // AC1 / AC2: The core finding — block_number: null bypasses validation and
  // triggers full cache invalidation.
  it('rejects block_number: null with 400 and invalidates nothing', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ block_number: null }))));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: unknown };
    expect(body.error).toBeTruthy();

    // Not a single cache operation must have run.
    expect(fakes.cache.delete).not.toHaveBeenCalled();
    expect(fakes.cache.deleteByPrefix).not.toHaveBeenCalled();
  });

  // block_number: wrong type (string)
  it('rejects block_number as a string with 400 and invalidates nothing', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ block_number: '100' }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  // tx_hash: null — the interface declares it as string, not string|null
  it('rejects tx_hash: null with 400 and invalidates nothing', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ tx_hash: null }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  it('rejects tx_hash as a number with 400', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ tx_hash: 0 }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  // log_index: null
  it('rejects log_index: null with 400 and invalidates nothing', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ log_index: null }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  // contract_address: null
  it('rejects contract_address: null with 400', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ contract_address: null }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  // data: null
  it('rejects data: null with 400', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ data: null }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  // protocol: invalid value
  it('rejects protocol not "v1" or "v2" with 400', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ protocol: 'v3' }))));
    expect(res.status).toBe(400);
    expect(fakes.cache.delete).not.toHaveBeenCalled();
  });

  // Sanity: valid events still pass — the validation must not reject correct payloads
  it('still accepts a fully valid event with 200', async () => {
    const { svc, fakes } = makeService();
    const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent())));
    expect(res.status).toBe(200);
    // Cache invalidation must still run for valid events.
    expect(fakes.cache.delete).toHaveBeenCalled();
  });
});