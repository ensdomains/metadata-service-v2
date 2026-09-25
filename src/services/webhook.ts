// Webhook handler for cache invalidation: a backend tells us an ENS name changed
// and we drop/warm what we cached for it. Sender-agnostic — the contract below
// originated with the zigens v2 indexer (zigens/src/webhooks/manager.zig) but any
// system that produces the same signed EnsNameEvent can POST it.
//
// CONTRACT:
//   Headers:
//     X-Webhook-Signature: sha256=<hex>   HMAC-SHA256 over "{timestamp}.{body}"
//     X-Webhook-Timestamp: <unix seconds> the value signed into the preamble
//     Content-Type: application/json
//   The HMAC key is the configured secret HEX-DECODED to raw bytes (zigens
//   generates a 32-byte secret and ships it hex-encoded). The receiver MUST
//   verify by recomputing HMAC over "<timestamp>.<rawBody>" and constant-time
//   comparing, and SHOULD reject timestamps outside a tolerance window (replay).
//
//   Body (flat event):
//     { event_type, protocol, block_number, tx_hash, log_index,
//       contract_address, name|null, namehash|null, data, timestamp }
import type { Context } from 'hono';
import { CacheService, CacheKeys } from './cache';
import { validateEnsName, canonicalizeName, MAX_ENS_NAME_LENGTH, MAX_NAME_LABELS } from '../utils/ens';

// A name the service never serves because of its size, however well-formed.
function isOverNameLimits(name: string): boolean {
  return name.length > MAX_ENS_NAME_LENGTH || name.split('.').length > MAX_NAME_LABELS;
}
import type { StorageManager } from '../utils/storage';
import { SUPPORTED_NETWORKS } from '../config/networks';

// Webhook payload: a flat ENS name-change event. (Wire shape originated with
// zigens' WebhookManager.buildPayload; kept stable for any sender.)
export interface EnsNameEvent {
  event_type: string;          // PascalCase event name, e.g. "NameRegistered"
  protocol: 'v1' | 'v2';       // ENS version (not chain) — see network mapping in index.ts
  block_number: number;
  tx_hash: string;
  log_index: number;
  contract_address: string;
  name: string | null;
  namehash: string | null;
  data: string;                // JSON-encoded extra data (opaque to us)
  timestamp: number;           // unix seconds
}

export interface WebhookValidationConfig {
  secret?: string;
  allowedIPs?: string[];
  requireAuth: boolean;
  /**
   * Escape hatch for local dev ONLY: accept webhooks even when no `secret` is
   * configured. Defaults to false → the receiver is fail-CLOSED, so a missing
   * secret in production rejects all webhooks (503) instead of silently accepting
   * unauthenticated cache-eviction / warming-amplification requests.
   */
  allowUnauthenticated?: boolean;
  /** Max allowed clock skew between X-Webhook-Timestamp and now, in seconds. */
  toleranceSecs?: number;
}

// Event types whose effect is primarily about expiry/lifecycle, so they also
// flush the expiry-bucketed internal caches.
const EXPIRY_AFFECTING_EVENTS = new Set([
  'NameRenewed', 'ExpiryUpdated', 'NameBurned', 'LabelUnregistered', 'NameMigrated',
]);

// Replay window for X-Webhook-Timestamp. Kept tight: zigens signs a fresh
// timestamp per delivery attempt, so legitimate retries are unaffected, while a
// captured request is replayable for at most this long. Override via WEBHOOK_TOLERANCE_SECS.
const DEFAULT_TOLERANCE_SECS = 120;

// Largest webhook body accepted (413 above it). Real events are well under
// 1 KiB. The body has to be read before its signature can be checked, so this
// bounds what any caller within the webhook rate limit can make us buffer and
// hash.
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export class WebhookService {
  private svgCacheKv?: KVNamespace;
  private metadataCacheKv?: KVNamespace;
  private storageManager?: StorageManager;

  constructor(
    private cache: CacheService,
    private config: WebhookValidationConfig = { requireAuth: false },
    svgCacheKv?: KVNamespace,
    storageManager?: StorageManager,
    metadataCacheKv?: KVNamespace,
  ) {
    this.svgCacheKv = svgCacheKv;
    this.storageManager = storageManager;
    this.metadataCacheKv = metadataCacheKv;
  }

  // Handle incoming webhook. Reads the request body exactly ONCE and uses that
  // same bytes for both signature verification and JSON parsing.
  async handleWebhook(c: Context): Promise<Response> {
    try {
      // Read the raw body a single time — signature is computed over these exact
      // bytes, so we must not re-read or re-serialize. Size-capped as it is read.
      const rawBody = await readBodyCapped(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
      if (rawBody === null) {
        return c.json({ error: 'Payload too large' }, 413);
      }

      const validationResult = await this.validateRequest(c, rawBody);
      if (!validationResult.valid) {
        return c.json({ error: validationResult.error }, (validationResult.status || 400) as any);
      }

      let payload: EnsNameEvent;
      try {
        payload = JSON.parse(rawBody) as EnsNameEvent;
      } catch {
        return c.json({ error: 'Invalid JSON payload' }, 400);
      }

      const payloadValidation = this.validatePayload(payload);
      if (!payloadValidation.valid) {
        return c.json({ error: payloadValidation.error }, 400);
      }

      // An event for a name over the service's limits (MAX_ENS_NAME_LENGTH,
      // MAX_NAME_LABELS), which anyone can create on-chain, has nothing cached
      // to invalidate: every route refuses such a name. Acknowledge it, so the
      // sender neither retries it nor takes this endpoint for a failing one.
      if (payload.name && isOverNameLimits(payload.name)) {
        console.log(`[webhook] ${payload.event_type}: ignoring a name this service does not serve (${String(payload.name).length} chars)`);
        return c.json({
          status: 'ignored',
          processed: false,
          event: payload.event_type,
          reason: 'Name not served by this service',
          timestamp: new Date().toISOString(),
        });
      }

      await this.processWebhookEvent(payload);

      return c.json({
        status: 'success',
        processed: true,
        event: payload.event_type,
        name: payload.name ?? null,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Webhook processing error:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }

  // Validate request authenticity (IP allowlist + HMAC signature + replay window).
  private async validateRequest(c: Context, rawBody: string): Promise<{
    valid: boolean;
    error?: string;
    status?: number;
  }> {
    // Fail-CLOSED: a webhook with no configured secret is rejected unless the
    // explicit local-dev escape hatch is set. This prevents an unauthenticated
    // cache-eviction / warming-amplification DoS if WEBHOOK_SECRET is unset in prod.
    if (!this.config.secret) {
      if (this.config.allowUnauthenticated) {
        return { valid: true };
      }
      return { valid: false, error: 'Webhook authentication is not configured', status: 503 };
    }

    if (this.config.allowedIPs && this.config.allowedIPs.length > 0) {
      // Trust ONLY CF-Connecting-IP — X-Forwarded-For is client-spoofable, so an
      // allowlist that honored it could be trivially bypassed.
      const clientIP = c.req.header('CF-Connecting-IP') || 'unknown';
      if (!this.config.allowedIPs.includes(clientIP)) {
        return { valid: false, error: 'Unauthorized IP address', status: 403 };
      }
    }

    if (this.config.secret) {
      const signatureHeader = c.req.header('X-Webhook-Signature');
      const timestampHeader = c.req.header('X-Webhook-Timestamp');

      if (!signatureHeader) {
        return { valid: false, error: 'Missing webhook signature', status: 401 };
      }
      if (!timestampHeader) {
        return { valid: false, error: 'Missing webhook timestamp', status: 401 };
      }

      // Replay protection: reject timestamps outside the tolerance window.
      const ts = Number(timestampHeader);
      if (!Number.isFinite(ts)) {
        return { valid: false, error: 'Invalid webhook timestamp', status: 401 };
      }
      const tolerance = this.config.toleranceSecs ?? DEFAULT_TOLERANCE_SECS;
      const nowSecs = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSecs - ts) > tolerance) {
        return { valid: false, error: 'Webhook timestamp outside tolerance window', status: 401 };
      }

      // Signed string is "{timestamp}.{body}" — must match the sender exactly.
      const expected = await this.calculateSignature(`${timestampHeader}.${rawBody}`, this.config.secret);
      const provided = signatureHeader.startsWith('sha256=')
        ? signatureHeader.slice('sha256='.length)
        : signatureHeader;

      if (!timingSafeEqualHex(provided, expected)) {
        return { valid: false, error: 'Invalid webhook signature', status: 401 };
      }
    }

    return { valid: true };
  }

  // Validate webhook payload structure (zigens flat event shape).
  private validatePayload(payload: any): { valid: boolean; error?: string } {
    if (!payload || typeof payload !== 'object') {
      return { valid: false, error: 'Invalid payload format' };
    }

    if (typeof payload.event_type !== 'string' || payload.event_type.length === 0) {
      return { valid: false, error: 'Missing or invalid event_type' };
    }
    if (typeof payload.timestamp !== 'number') {
      return { valid: false, error: 'Missing or invalid timestamp' };
    }

    // A name OR namehash must be present to target invalidation. (zigens may send
    // either; some events carry only a namehash.)
    if (!payload.name && !payload.namehash) {
      return { valid: false, error: 'Event must include a name or namehash' };
    }

    // When a name is present, it must be a well-formed ENS name (one over the
    // service's length or depth limits is acknowledged in handleWebhook).
    if (payload.name != null && typeof payload.name !== 'string') {
      return { valid: false, error: 'Invalid domain name format' };
    }
    if (payload.name && !isOverNameLimits(payload.name) && !validateEnsName(payload.name)) {
      return { valid: false, error: 'Invalid domain name format' };
    }

    return { valid: true };
  }

  // Process webhook event and invalidate the relevant caches.
  private async processWebhookEvent(event: EnsNameEvent): Promise<void> {
    // Canonicalize to match the form the read path writes its cache keys in.
    const domainName = event.name ? canonicalizeName(event.name) : null;

    // Without a name we cannot target the name-keyed caches. Acknowledge success
    // (so the sender does not retry) but there is nothing to invalidate.
    if (!domainName) {
      console.log(`[webhook] ${event.event_type} for namehash ${event.namehash ?? '(none)'} — no name, nothing to invalidate`);
      return;
    }

    console.log(`[webhook] processing ${event.event_type} for ${domainName}`);

    try {
      // Internal ensnode-response caches, for both networks (the payload carries
      // ENS protocol v1/v2, not the chain, so we invalidate both to be safe).
      // NOTE: of these, only `hierarchy` is currently written by a read path
      // (MetadataService.getRegistryHierarchy). The `domain`/`migrationStatus`
      // deletes are deliberately kept as defensive no-ops so that if those internal
      // caches are ever wired up, invalidation already covers them. The
      // user-facing data is flushed by invalidateMetadataCache (`meta:`) below.
      const networks = ['mainnet', 'sepolia'];
      await Promise.all(networks.flatMap(net => [
        this.cache.delete(CacheKeys.domain(domainName, net)),
        this.cache.delete(CacheKeys.migrationStatus(domainName, net)),
        this.cache.delete(CacheKeys.hierarchy(domainName, net)),
      ]));

      // Batch caches that might include this domain.
      await this.invalidateBatchCaches();

      // Expiry-bucketed caches for lifecycle events.
      if (EXPIRY_AFFECTING_EVENTS.has(event.event_type)) {
        await this.invalidateExpiryCaches();
      }

      // Endpoint-level metadata cache (meta:{network}:{registryType}:{name}).
      await this.invalidateMetadataCache(domainName);

      // Image caches (KV SVG + R2 avatar/SVG).
      await this.invalidateImageCaches(domainName);

      console.log(`[webhook] cache invalidation completed for ${domainName}`);
    } catch (error) {
      console.error(`[webhook] failed to process for ${domainName}:`, error);
      throw error;
    }
  }

  // Invalidate endpoint-level metadata cache entries for a domain. Metadata keys
  // are fully deterministic (`meta:{network}:{registryType}:{name}` — see
  // metadata-cache.ts buildCacheKey), so delete the exact key set directly.
  // NEVER list the whole `meta:` namespace here: KV list() returns at most 1000
  // keys per page, so a listing-based purge silently misses entries once the
  // namespace outgrows a page (which production traffic does almost immediately).
  private async invalidateMetadataCache(domainName: string): Promise<void> {
    if (!this.metadataCacheKv) return;
    try {
      const keys = SUPPORTED_NETWORKS.flatMap((network) =>
        (['registry', 'namewrapper'] as const).map(
          (registryType) => `meta:${network}:${registryType}:${domainName}`,
        ),
      );
      await Promise.all(keys.map((k) => this.metadataCacheKv!.delete(k)));
    } catch (err) {
      console.warn(`[webhook] failed to invalidate metadata cache for ${domainName}:`, err);
    }
  }

  // Invalidate image caches (SVG KV entries + R2 avatar/SVG assets).
  private async invalidateImageCaches(domainName: string): Promise<void> {
    if (this.svgCacheKv) {
      try {
        // SVG keys embed variable params (status/size) after the name, so this
        // one needs a prefix list — paginate the cursor: a single list() page
        // caps at 1000 keys.
        const prefix = `svg:${domainName}:`;
        let cursor: string | undefined;
        do {
          const list = await this.svgCacheKv.list({ prefix, cursor });
          if (list.keys.length > 0) {
            await Promise.all(list.keys.map((k) => this.svgCacheKv!.delete(k.name)));
          }
          cursor = list.list_complete ? undefined : list.cursor;
        } while (cursor);
      } catch (err) {
        console.warn(`[webhook] failed to invalidate SVG KV cache for ${domainName}:`, err);
      }
    }

    if (this.storageManager) {
      try {
        await Promise.all([
          // avatars are keyed `avatars/${name}:${network}` — prefix-delete both networks
          this.storageManager.deleteByPrefix(`avatars/${domainName}:`),
          this.storageManager.deleteByPrefix(`svg/svg:${domainName}:`),
        ]);
      } catch (err) {
        console.warn(`[webhook] failed to invalidate R2 assets for ${domainName}:`, err);
      }
    }
  }

  // Invalidate batch caches that might contain the domain.
  private async invalidateBatchCaches(): Promise<void> {
    try {
      await this.cache.deleteByPrefix('batch:', 'indexer');
    } catch (error) {
      console.warn('[webhook] failed to invalidate batch caches:', error);
    }
  }

  // Invalidate expiry-related caches.
  private async invalidateExpiryCaches(): Promise<void> {
    try {
      await this.cache.deleteByPrefix('expiring:', 'indexer');
      await this.cache.deleteByPrefix('recent:', 'indexer');
    } catch (error) {
      console.warn('[webhook] failed to invalidate expiry caches:', error);
    }
  }

  // Compute HMAC-SHA256(key = hex-decoded secret, message) and return the lower-hex
  // digest (no "sha256=" prefix). Matches zigens' computeWebhookSignature.
  private async calculateSignature(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyBytes = secretToKeyBytes(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message) as BufferSource);
    return bytesToHex(new Uint8Array(signature));
  }
}

// Reads a request body as UTF-8 text, like Request.text(), or returns null once
// it is known to be larger than maxBytes: at once when Content-Length says so,
// otherwise (e.g. a chunked body, which has none) as soon as the bytes read
// pass the cap, without reading the rest.
async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (Number(req.headers.get('Content-Length')) > maxBytes) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// --- crypto helpers ---

// zigens hex-decodes the secret to raw bytes before HMAC. If the configured
// secret is valid hex, decode it (canonical case). Otherwise fall back to its
// UTF-8 bytes so a non-hex passphrase still works.
function secretToKeyBytes(secret: string): Uint8Array {
  if (secret.length > 0 && secret.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(secret)) {
    return hexToBytes(secret);
  }
  return new TextEncoder().encode(secret);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

// Constant-time comparison of two hex strings. Returns false for length mismatch
// (after a fixed-cost pass to avoid leaking length via early return timing).
export function timingSafeEqualHex(a: string, b: string): boolean {
  const al = a.length;
  const bl = b.length;
  let diff = al ^ bl;
  const len = Math.max(al, bl);
  for (let i = 0; i < len; i++) {
    const ca = i < al ? a.charCodeAt(i) : 0;
    const cb = i < bl ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
