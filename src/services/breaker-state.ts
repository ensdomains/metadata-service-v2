// Circuit-breaker state shared across isolates through KV.
//
// FallbackService's breaker lives in one isolate's memory, so every other
// isolate (and each new one) would keep probing an upstream that one of them
// already found down. When an isolate finds the upstream still down after a
// cooldown (SHARED_TRIP_AFTER_FAILURES in fallback.ts) it records the "tripped
// until" time (epoch ms) here; other isolates read it and skip the upstream
// until then.
//
// KV caches every read in the location that made it, a missing key included,
// for its cacheTtl (60 s by default, 30 s at the least), and a write made in
// another location does not refresh that copy. With a single key, a location
// that read it just before another location wrote a trip would not see the
// trip for about the whole one-minute cooldown. So the state is kept under one
// key per SHARED_BREAKER_SLICE_MS of time: a trip is written to the key of
// every slice it covers, and a reader reads the key of the slice it is in. A
// slice's key is first read once that slice has begun, after the trip was
// written to it, so a stale copy lasts only until the end of the slice being
// read: other locations see a trip within about one slice (plus the isolate's
// read cache), and the location that wrote it sees it at once. It is still not
// a coordinated, exact state.

// How long an isolate reuses its last read of the shared state before reading
// KV again, so the hot path does not read KV on every request.
export const SHARED_BREAKER_READ_CACHE_MS = 5_000;

// The length of the time slices the state is keyed by (see above): how long a
// location can keep missing a trip because of a copy it read just before.
export const SHARED_BREAKER_SLICE_MS = 10_000;

const sliceOf = (ms: number) => Math.floor(ms / SHARED_BREAKER_SLICE_MS);

// KV rejects an expirationTtl below 60 seconds.
const KV_MIN_EXPIRATION_TTL_SECS = 60;

export class SharedBreakerState {
  private cachedUntil = 0;
  private cachedAt = Number.NEGATIVE_INFINITY;
  // The last value read from KV and the deadline taken from it (see deadline()).
  private lastValue: string | null = null;
  private lastDeadline = 0;

  // `cooldownMs` is the breaker's cooldown: no trip read from KV lasts longer.
  constructor(private kv: KVNamespace, private key: string, private cooldownMs: number) {}

  // Epoch ms until which the breaker is tripped (in the past or 0 when it is
  // not). Reads KV at most once per SHARED_BREAKER_READ_CACHE_MS; a failed read
  // counts as "not tripped" (fail open: the upstream is simply tried).
  async trippedUntil(): Promise<number> {
    const now = Date.now();
    if (now - this.cachedAt < SHARED_BREAKER_READ_CACHE_MS) return this.cachedUntil;
    // Claim the refresh before reading, so concurrent callers use the last
    // known value instead of awaiting this read. The read's promise must not
    // be shared: in Workers its I/O belongs to the request that started it,
    // and if that request is cancelled (client disconnect, timeout) it never
    // settles, which would hang every request awaiting it.
    this.cachedAt = now;
    return this.read();
  }

  // Records a trip until `until` (epoch ms), in the key of every slice from now
  // to its end (at most one cooldown ahead). The value, not a key's TTL, decides
  // when the trip ends: a TTL only keeps its key past the end of its slice,
  // floored to KV's minimum, so the keys clean themselves up. Skips the write
  // when a trip this isolate already knows of is still active (e.g. concurrent
  // failures of the same outage). A failed write is logged and ignored: the
  // local breaker still applies.
  async trip(until: number): Promise<void> {
    const now = Date.now();
    const alreadyTripped = this.cachedUntil > now;
    this.remember(until);
    if (alreadyTripped) return;
    const writes: Promise<void>[] = [];
    for (let slice = sliceOf(now); slice <= sliceOf(Math.min(until, now + this.cooldownMs)); slice++) {
      const sliceEndsIn = (slice + 1) * SHARED_BREAKER_SLICE_MS - now;
      writes.push(this.kv.put(this.sliceKey(slice), String(until), {
        expirationTtl: Math.max(KV_MIN_EXPIRATION_TTL_SECS, Math.ceil(sliceEndsIn / 1000)),
      }));
    }
    await this.settle(writes, 'share trip of');
  }

  // Clears the shared trip (manual recovery): the slices a trip written up to
  // now can cover.
  async reset(): Promise<void> {
    const now = Date.now();
    this.cachedUntil = 0;
    this.cachedAt = now;
    const deletes: Promise<void>[] = [];
    for (let slice = sliceOf(now); slice <= sliceOf(now + this.cooldownMs); slice++) {
      deletes.push(this.kv.delete(this.sliceKey(slice)));
    }
    await this.settle(deletes, 'clear');
  }

  private sliceKey(slice: number): string {
    return `${this.key}:${slice}`;
  }

  private async settle(ops: Promise<void>[], action: string): Promise<void> {
    const failed = (await Promise.allSettled(ops)).filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`[breaker] could not ${action} ${this.key} (${failed.length} of ${ops.length} keys):`, failed[0].reason);
    }
  }

  private async read(): Promise<number> {
    let until = 0;
    try {
      until = this.deadline(await this.kv.get(this.sliceKey(sliceOf(Date.now()))));
    } catch (err) {
      console.warn(`[breaker] could not read ${this.key}, assuming not tripped:`, err);
    }
    this.remember(until);
    return this.cachedUntil;
  }

  // The deadline a value read from KV stands for, clamped to one cooldown from
  // when this isolate first read that value, so a bad or far-future value
  // cannot keep the breaker open for longer. Reading the same value again
  // keeps its deadline (re-reads of a stuck value must not push it forward);
  // a new trip writes a new value.
  private deadline(value: string | null): number {
    if (value !== this.lastValue) {
      const parsed = parseInt(value ?? '', 10);
      this.lastValue = value;
      this.lastDeadline = Number.isFinite(parsed) ? Math.min(parsed, Date.now() + this.cooldownMs) : 0;
    }
    return this.lastDeadline;
  }

  // A later deadline always wins, so a read that raced a local trip cannot
  // shorten it.
  private remember(until: number): void {
    this.cachedUntil = Math.max(this.cachedUntil, until);
    this.cachedAt = Date.now();
  }
}
