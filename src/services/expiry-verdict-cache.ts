// In-isolate cache of MetadataService.checkExpiry's live verdicts (WEB-1552).
// checkExpiry gates every metadata, image and rasterize request (and each batch
// entry) before any other cache, so without this every L0 edge miss paid its
// on-chain reads (v2 getState, v1 registrar nameExpires) even when the metadata
// itself was a warm KV hit.
//
// Only a live verdict read from the chain is stored. It is trusted for at most
// EXPIRY_VERDICT_TTL_MS, and never past the name's expiry instant when the chain
// reported one: a name that lapses while cached is re-read at that moment, not
// served for the rest of the TTL. Renewals and registrations keep a live verdict
// live; only a transaction that ends a registration before its expiry (a v2
// unregister) makes it wrong early. Nothing else is stored:
// - An expired verdict (410) can be undone at any moment, by a renewal in the
//   grace period or a re-registration, and the webhook reaches only the isolate
//   that handles it. A cached 410 would outlive the renewal in every other
//   isolate, so an expired name reads the chain on every request, as before.
// - checkExpiry's fail-open path (chain unreadable) never reaches the cache.
//
// Scope: getServices keeps one MetadataService per network per isolate, each
// with its own cache, so a verdict is per (network, name). Entries are keyed by
// namehash, so the webhook can evict one from an event that carries the name or
// only its namehash; it does so only in the isolate that handles it, and any
// other isolate re-reads within the TTL, the same bound the per-colo L0 edge
// cache has (EDGE_CACHE_MAX_AGE_SECS in index.ts).
//
// Memory: a key is a namehash however long the name the caller sent, so the
// cache holds at most EXPIRY_VERDICT_MAX_ENTRIES entries of fixed size.

import { namehash } from "viem/ens";

/** Longest a verdict is reused without re-reading the chain. */
export const EXPIRY_VERDICT_TTL_MS = 5 * 60 * 1000;
/** Most verdicts kept per network; the least recently used is dropped beyond it. */
export const EXPIRY_VERDICT_MAX_ENTRIES = 10_000;

/**
 * The cache key of a canonical name: its namehash, built from the same viem
 * labelhash checkExpiry reads the chain with. (ensjs's namehash, re-exported
 * by utils/ens, normalizes each label first, which throws on names the gate
 * still has to check and can hash a different label than the one read.)
 */
export function expiryVerdictKey(canonicalName: string): string {
  return namehash(canonicalName);
}

export class ExpiryVerdictCache {
  // namehash → the instant the live verdict stops being trusted. Map iteration
  // follows insertion order, so re-inserting on every hit keeps the least
  // recently used entry first.
  private entries = new Map<string, number>();
  // Per-key set of active-read tokens. An in-flight chain read registers a
  // token before starting; setLive checks the token is still active for that
  // key. delete() clears the set for the evicted key only, so an unrelated
  // eviction never invalidates an in-flight read for a different name.
  // Tokens are always removed via setLive (success) or finishRead
  // (fail-open/error), so the map never holds a key with an empty set.
  private activeReads = new Map<string, Set<number>>();
  private nextToken = 0;

  constructor(
    private readonly ttlMs = EXPIRY_VERDICT_TTL_MS,
    private readonly maxEntries = EXPIRY_VERDICT_MAX_ENTRIES,
  ) {}

  /** Whether a live verdict for `key` is cached and still trusted. */
  isLive(key: string): boolean {
    const validUntil = this.entries.get(key);
    if (validUntil === undefined) return false;
    this.entries.delete(key);
    if (Date.now() >= validUntil) return false;
    this.entries.set(key, validUntil);
    return true;
  }

  /** Registers an active read for `key` and returns a token that setLive
   *  must present to store a verdict. The caller must call finishRead on
   *  every path that does not reach setLive (fail-open, error). */
  startRead(key: string): number {
    const token = ++this.nextToken;
    let set = this.activeReads.get(key);
    if (!set) {
      set = new Set();
      this.activeReads.set(key, set);
    }
    set.add(token);
    return token;
  }

  /** Releases an active-read token without storing a verdict (fail-open /
   *  error path). Idempotent — safe to call even if the token was already
   *  consumed by setLive or evicted. */
  finishRead(key: string, token: number): void {
    const set = this.activeReads.get(key);
    if (!set) return;
    set.delete(token);
    if (set.size === 0) this.activeReads.delete(key);
  }

  /** Stores a live verdict read from the chain; `expiryMs` is the name's
   *  expiry instant, or null when the chain reported none. `token` must be
   *  the value from startRead for this key. When the token is no longer
   *  active (evicted before this read completed), the store is silently
   *  dropped — the next checkExpiry will start a fresh read. */
  setLive(key: string, expiryMs: number | null, token: number): void {
    const set = this.activeReads.get(key);
    if (!set || !set.has(token)) return;
    set.delete(token);
    if (set.size === 0) this.activeReads.delete(key);
    const now = Date.now();
    const lifetime = expiryMs === null ? this.ttlMs : Math.min(this.ttlMs, expiryMs - now);
    this.entries.delete(key);
    if (lifetime <= 0) return;
    this.entries.set(key, now + lifetime);
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  /** Evicts the cached verdict for `key` and invalidates every in-flight
   *  read for the same key so none of them can store afterward. */
  delete(key: string): void {
    this.activeReads.delete(key);
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
