// Circuit-breaker state shared across isolates through KV.
//
// FallbackService's breaker lives in one isolate's memory, so every other
// isolate (and each new one) would keep probing an upstream that one of them
// already found down. When an isolate trips the breaker it records the
// "tripped until" time (epoch ms) here; other isolates read it and skip the
// upstream until then.
//
// KV is eventually consistent: a trip is visible at once in the location that
// wrote it, and in other locations once their cached read of the key expires
// (up to about a minute). Good enough for a breaker whose cooldown is a
// minute; it is not a coordinated, exact state.

// How long an isolate reuses its last read of the shared state before reading
// KV again, so the hot path does not read KV on every request.
export const SHARED_BREAKER_READ_CACHE_MS = 5_000;

// KV rejects an expirationTtl below 60 seconds.
const KV_MIN_EXPIRATION_TTL_SECS = 60;

export class SharedBreakerState {
  private cachedUntil = 0;
  private cachedAt = Number.NEGATIVE_INFINITY;
  private pendingRead: Promise<number> | null = null;

  constructor(private kv: KVNamespace, private key: string) {}

  // Epoch ms until which the breaker is tripped (in the past or 0 when it is
  // not). Reads KV at most once per SHARED_BREAKER_READ_CACHE_MS; a failed read
  // counts as "not tripped" (fail open: the upstream is simply tried).
  async trippedUntil(): Promise<number> {
    if (Date.now() - this.cachedAt < SHARED_BREAKER_READ_CACHE_MS) return this.cachedUntil;
    this.pendingRead ??= this.read().finally(() => {
      this.pendingRead = null;
    });
    return this.pendingRead;
  }

  // Records a trip until `until` (epoch ms). The value, not the key's TTL,
  // decides when the trip ends: the TTL is only floored to KV's minimum so the
  // key cleans itself up. Skips the write when a trip this isolate already
  // knows of is still active (e.g. concurrent failures of the same outage).
  // A failed write is logged and ignored: the local breaker still applies.
  async trip(until: number): Promise<void> {
    const now = Date.now();
    const alreadyTripped = this.cachedUntil > now;
    this.remember(until);
    if (alreadyTripped) return;
    try {
      await this.kv.put(this.key, String(until), {
        expirationTtl: Math.max(KV_MIN_EXPIRATION_TTL_SECS, Math.ceil((until - now) / 1000)),
      });
    } catch (err) {
      console.warn(`[breaker] could not share trip of ${this.key}:`, err);
    }
  }

  // Clears the shared trip (manual recovery).
  async reset(): Promise<void> {
    this.cachedUntil = 0;
    this.cachedAt = Date.now();
    try {
      await this.kv.delete(this.key);
    } catch (err) {
      console.warn(`[breaker] could not clear ${this.key}:`, err);
    }
  }

  private async read(): Promise<number> {
    let until = 0;
    try {
      const parsed = parseInt((await this.kv.get(this.key)) ?? '', 10);
      if (Number.isFinite(parsed)) until = parsed;
    } catch (err) {
      console.warn(`[breaker] could not read ${this.key}, assuming not tripped:`, err);
    }
    this.remember(until);
    return this.cachedUntil;
  }

  // A later deadline always wins, so a read that raced a local trip cannot
  // shorten it.
  private remember(until: number): void {
    this.cachedUntil = Math.max(this.cachedUntil, until);
    this.cachedAt = Date.now();
  }
}
