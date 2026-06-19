import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookService, timingSafeEqualHex } from '../src/services/webhook';

// --- helpers ---

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Mirror of zigens computeWebhookSignature: HMAC-SHA256(hexDecode(secret), "{ts}.{body}")
async function signZigens(secretHex: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(secretHex) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`) as BufferSource);
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

// Minimal Hono Context double: only what WebhookService touches.
function makeCtx(body: string, headers: Record<string, string> = {}) {
  const textSpy = vi.fn(async () => body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    textSpy,
    req: {
      text: textSpy,
      header: (name: string) => lower[name.toLowerCase()],
    },
    json: (obj: any, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }),
  } as any;
}

// Fakes for the cache layers WebhookService writes through.
function makeFakes() {
  const cache = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  const svgCacheKv = {
    list: vi.fn(async () => ({ keys: [{ name: 'svg:vitalik.eth:migrated:518:518' }] })),
    delete: vi.fn(async () => {}),
  };
  const metadataCacheKv = {
    list: vi.fn(async () => ({
      keys: [
        { name: 'meta:mainnet:registry:vitalik.eth' },
        { name: 'meta:sepolia:namewrapper:vitalik.eth' },
        { name: 'meta:mainnet:registry:other.eth' }, // must NOT be deleted
      ],
    })),
    delete: vi.fn(async () => {}),
  };
  const storageManager = {
    delete: vi.fn(async () => {}),
    deleteByPrefix: vi.fn(async () => {}),
  };
  return { cache, svgCacheKv, metadataCacheKv, storageManager };
}

function makeService(config: any, fakes = makeFakes()) {
  const svc = new WebhookService(
    fakes.cache as any,
    config,
    fakes.svgCacheKv as any,
    fakes.storageManager as any,
    fakes.metadataCacheKv as any,
  );
  return { svc, fakes };
}

const SECRET = '0'.repeat(64); // 32 zero bytes, hex-encoded (zigens format)

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

describe('timingSafeEqualHex', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualHex('abcdef', 'abcdef')).toBe(true);
  });
  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqualHex('abcdef', 'abcde0')).toBe(false);
  });
  it('returns false for different lengths', () => {
    expect(timingSafeEqualHex('abc', 'abcdef')).toBe(false);
  });
});

describe('WebhookService (zigens contract)', () => {
  describe('no auth required', () => {
    it('accepts a valid payload and invalidates caches', async () => {
      const { svc, fakes } = makeService({ requireAuth: false, allowUnauthenticated: true });
      const body = JSON.stringify(validEvent());
      const res = await svc.handleWebhook(makeCtx(body));

      expect(res.status).toBe(200);
      // internal caches: 3 keys × 2 networks
      expect(fakes.cache.delete).toHaveBeenCalledTimes(6);
      // batch caches flushed
      expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('batch:', 'ensnode');
      // metadata cache: only the two keys ending in ":vitalik.eth"
      expect(fakes.metadataCacheKv.delete).toHaveBeenCalledTimes(2);
      expect(fakes.metadataCacheKv.delete).toHaveBeenCalledWith('meta:mainnet:registry:vitalik.eth');
      expect(fakes.metadataCacheKv.delete).toHaveBeenCalledWith('meta:sepolia:namewrapper:vitalik.eth');
      expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalledWith('meta:mainnet:registry:other.eth');
      // image caches
      expect(fakes.svgCacheKv.list).toHaveBeenCalledWith({ prefix: 'svg:vitalik.eth:' });
      expect(fakes.storageManager.deleteByPrefix).toHaveBeenCalledWith('avatars/vitalik.eth:');
      expect(fakes.storageManager.deleteByPrefix).toHaveBeenCalledWith('svg/svg:vitalik.eth:');
    });

    it('reads the request body exactly once', async () => {
      const { svc } = makeService({ requireAuth: false, allowUnauthenticated: true });
      const ctx = makeCtx(JSON.stringify(validEvent()));
      await svc.handleWebhook(ctx);
      expect(ctx.textSpy).toHaveBeenCalledTimes(1);
    });

    it('no-ops invalidation for a name-less (namehash-only) event', async () => {
      const { svc, fakes } = makeService({ requireAuth: false, allowUnauthenticated: true });
      const body = JSON.stringify(validEvent({ name: null }));
      const res = await svc.handleWebhook(makeCtx(body));
      expect(res.status).toBe(200);
      expect(fakes.cache.delete).not.toHaveBeenCalled();
      expect(fakes.metadataCacheKv.delete).not.toHaveBeenCalled();
    });

    it('flushes expiry caches for lifecycle events', async () => {
      const { svc, fakes } = makeService({ requireAuth: false, allowUnauthenticated: true });
      await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ event_type: 'NameRenewed' }))));
      expect(fakes.cache.deleteByPrefix).toHaveBeenCalledWith('expiring:', 'ensnode');
    });
  });

  describe('fail-closed auth', () => {
    it('rejects with 503 when no secret is configured and dev override is off', async () => {
      const { svc, fakes } = makeService({ requireAuth: false }); // no secret, no allowUnauthenticated
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent())));
      expect(res.status).toBe(503);
      // nothing invalidated when rejected
      expect(fakes.cache.delete).not.toHaveBeenCalled();
    });
  });

  describe('signature verification', () => {
    it('accepts a correctly signed request', async () => {
      const { svc } = makeService({ requireAuth: true, secret: SECRET });
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify(validEvent({ timestamp: ts }));
      const sig = await signZigens(SECRET, ts, body);
      const res = await svc.handleWebhook(makeCtx(body, {
        'X-Webhook-Signature': sig,
        'X-Webhook-Timestamp': String(ts),
      }));
      expect(res.status).toBe(200);
    });

    it('rejects an invalid signature with 401', async () => {
      const { svc } = makeService({ requireAuth: true, secret: SECRET });
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify(validEvent({ timestamp: ts }));
      const res = await svc.handleWebhook(makeCtx(body, {
        'X-Webhook-Signature': 'sha256=' + 'f'.repeat(64),
        'X-Webhook-Timestamp': String(ts),
      }));
      expect(res.status).toBe(401);
    });

    it('rejects a missing signature with 401', async () => {
      const { svc } = makeService({ requireAuth: true, secret: SECRET });
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify(validEvent({ timestamp: ts }));
      const res = await svc.handleWebhook(makeCtx(body, { 'X-Webhook-Timestamp': String(ts) }));
      expect(res.status).toBe(401);
    });

    it('rejects a missing timestamp with 401', async () => {
      const { svc } = makeService({ requireAuth: true, secret: SECRET });
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify(validEvent({ timestamp: ts }));
      const sig = await signZigens(SECRET, ts, body);
      const res = await svc.handleWebhook(makeCtx(body, { 'X-Webhook-Signature': sig }));
      expect(res.status).toBe(401);
    });

    it('rejects a stale timestamp (replay) with 401', async () => {
      const { svc } = makeService({ requireAuth: true, secret: SECRET, toleranceSecs: 300 });
      const staleTs = Math.floor(Date.now() / 1000) - 1000; // > tolerance
      const body = JSON.stringify(validEvent({ timestamp: staleTs }));
      const sig = await signZigens(SECRET, staleTs, body);
      const res = await svc.handleWebhook(makeCtx(body, {
        'X-Webhook-Signature': sig,
        'X-Webhook-Timestamp': String(staleTs),
      }));
      expect(res.status).toBe(401);
    });
  });

  describe('payload validation', () => {
    it('rejects invalid JSON with 400', async () => {
      const { svc } = makeService({ requireAuth: false, allowUnauthenticated: true });
      const res = await svc.handleWebhook(makeCtx('not json{'));
      expect(res.status).toBe(400);
    });

    it('rejects a payload missing event_type with 400', async () => {
      const { svc } = makeService({ requireAuth: false, allowUnauthenticated: true });
      const bad = validEvent();
      delete (bad as any).event_type;
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(bad)));
      expect(res.status).toBe(400);
    });

    it('rejects a malformed domain name with 400', async () => {
      const { svc } = makeService({ requireAuth: false, allowUnauthenticated: true });
      const res = await svc.handleWebhook(makeCtx(JSON.stringify(validEvent({ name: 'noTld' }))));
      expect(res.status).toBe(400);
    });
  });
});
