// In-isolate cache of MetadataService.checkExpiry verdicts (WEB-1552).
// checkExpiry gates every metadata, image and rasterize request (and each batch
// entry) before any other cache, so without this every L0 edge miss paid its
// on-chain reads (v2 getState, v1 registrar nameExpires) even when the metadata
// itself was a warm KV hit.
//
// A verdict is "live" (with the expiry instant when the chain reported one) or
// "expired" (with the instant it expired). An entry is trusted for at most
// EXPIRY_VERDICT_TTL_MS, and a live entry never past its expiry instant: a name
// that lapses while cached is re-read at that moment, not served for the rest
// of the TTL. Only verdicts read from the chain are stored; checkExpiry's
// fail-open path (chain unreadable) never reaches the cache.
//
// Scope: getServices keeps one MetadataService per network per isolate, each
// with its own cache, so a verdict is keyed by (network, canonical name). The
// webhook evicts a changed name only in the isolate that handles it; any other
// isolate picks up a renewal, re-registration or burn within the TTL, the same
// bound the per-colo L0 edge cache has (EDGE_CACHE_MAX_AGE_SECS in index.ts).

/** Longest a verdict is reused without re-reading the chain. */
export const EXPIRY_VERDICT_TTL_MS = 5 * 60 * 1000;
/** Most verdicts kept per network; the least recently used is dropped beyond it. */
export const EXPIRY_VERDICT_MAX_ENTRIES = 10_000;

export type ExpiryVerdict =
  | { expired: false; expiryMs: number | null } // null: the chain reported no expiry
  | { expired: true; expiryMs: number };

export class ExpiryVerdictCache {
  // Map iteration follows insertion order, so re-inserting on every hit keeps
  // the least recently used entry first.
  private entries = new Map<string, { verdict: ExpiryVerdict; validUntil: number }>();

  constructor(
    private readonly ttlMs = EXPIRY_VERDICT_TTL_MS,
    private readonly maxEntries = EXPIRY_VERDICT_MAX_ENTRIES,
  ) {}

  get(name: string): ExpiryVerdict | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    this.entries.delete(name);
    if (Date.now() >= entry.validUntil) return undefined;
    this.entries.set(name, entry);
    return entry.verdict;
  }

  set(name: string, verdict: ExpiryVerdict): void {
    const now = Date.now();
    const lifetime = !verdict.expired && verdict.expiryMs !== null
      ? Math.min(this.ttlMs, verdict.expiryMs - now)
      : this.ttlMs;
    this.entries.delete(name);
    if (lifetime <= 0) return;
    this.entries.set(name, { verdict, validUntil: now + lifetime });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  delete(name: string): void {
    this.entries.delete(name);
  }

  get size(): number {
    return this.entries.size;
  }
}
