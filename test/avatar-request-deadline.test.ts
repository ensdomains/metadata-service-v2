import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mainnet } from 'viem/chains';
import { AvatarService } from '../src/services/avatar';
import { RequestDeadlineError, UpstreamError } from '../src/services/errors';
import { withRequestBudget } from '../src/services/request-budget';

// W8-BUDGET-001: the request deadline must gate every upstream attempt including
// avatar/header resolver RPC work AND metadata lookups, at the per-attempt
// boundary (lookup, immediately before work()). Each attempt must be causally
// bounded by the returned request duration — a hung resolver at exactly 1000ms
// must be killed by the deadline, not left to the fixed 8s media timeout.

const DEADLINE_MS = 25_000;
const MEDIA_TIMEOUT_MS = 8_000;
const FIRST_UPSTREAM_ERROR = new UpstreamError('primary failed');

// Never resolves; used to simulate a hung resolver.
const hung = () => new Promise<never>(() => {});
// Resolves after `ms` fake-time ms.
const afterMs = <T>(ms: number, value: T): (() => Promise<T>) => () =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

type FakeResolver = { getAvatar?: Mock; getHeader?: Mock; getMetadata?: Mock };

function makeService(primary: FakeResolver, legacy?: FakeResolver): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', mainnet);
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = legacy;
  return svc;
}

// Advance fake time until `promise` settles (or `maxMs` pass).
async function settle<T>(promise: Promise<T>, maxMs: number) {
  const outcome: { done: boolean; value?: T; error?: unknown; elapsed: number } = { done: false, elapsed: 0 };
  promise.then(
    (value) => { outcome.done = true; outcome.value = value; },
    (error) => { outcome.done = true; outcome.error = error; },
  );
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(0);
  while (!outcome.done && Date.now() - start < maxMs) {
    await vi.advanceTimersByTimeAsync(50);
  }
  outcome.elapsed = Date.now() - start;
  return outcome;
}

// Run fn inside a request budget whose deadline is `leftMs` away.
function inRequest<T>(leftMs: number, fn: () => Promise<T>): Promise<T> {
  return withRequestBudget(() => {
    vi.setSystemTime(Date.now() + DEADLINE_MS - leftMs);
    return fn();
  });
}

function expectDeadlineError(error: unknown) {
  expect(error).toBeInstanceOf(RequestDeadlineError);
  expect((error as Error).name).toBe('RequestDeadlineError');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Per-attempt gate: deadline reached (0ms / 999ms) ───────────────────────

describe('per-attempt deadline gate for avatar', () => {
  it('rejects at 0ms remaining without invoking the resolver', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(0, () => svc.getAvatarImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('rejects at 999ms remaining (under the 1000ms floor) without invoking the resolver', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(999, () => svc.getAvatarImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('allows one attempt at exactly 1000ms remaining', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });

  it('invokes the resolver normally when ample time remains', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(10_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getAvatar).toHaveBeenCalled();
  });
});

// ── Per-attempt gate for header ────────────────────────────────────────────

describe('per-attempt deadline gate for header', () => {
  it('rejects at 0ms remaining without invoking the resolver', async () => {
    const getHeader = vi.fn(async () => null);
    const svc = makeService({ getHeader });

    const out = await settle(inRequest(0, () => svc.getHeaderImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getHeader).not.toHaveBeenCalled();
  });

  it('rejects at 999ms remaining without invoking the resolver', async () => {
    const getHeader = vi.fn(async () => null);
    const svc = makeService({ getHeader });

    const out = await settle(inRequest(999, () => svc.getHeaderImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getHeader).not.toHaveBeenCalled();
  });

  it('allows one attempt at exactly 1000ms remaining', async () => {
    const getHeader = vi.fn(async () => null);
    const svc = makeService({ getHeader });

    const out = await settle(inRequest(1000, () => svc.getHeaderImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getHeader).toHaveBeenCalledTimes(1);
  });
});

// ── Legacy fallback: primary at 1000ms consuming 1ms → legacy at 999ms gated

describe('legacy fallback per-attempt gating', () => {
  it('gates legacy fallback when primary (null) consumed time past the floor', async () => {
    const getAvatar = vi.fn(async () => {
      vi.advanceTimersByTime(1);
      return null;
    });
    const legacyGetAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar }, { getAvatar: legacyGetAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(legacyGetAvatar).not.toHaveBeenCalled();
    expectDeadlineError(out.error);
  });

  it('gates legacy fallback when primary (UpstreamError) consumed time past the floor', async () => {
    const getAvatar = vi.fn(async () => {
      vi.advanceTimersByTime(1);
      throw FIRST_UPSTREAM_ERROR;
    });
    const legacyGetAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar }, { getAvatar: legacyGetAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(legacyGetAvatar).not.toHaveBeenCalled();
    expectDeadlineError(out.error);
  });
});

// ── Metadata path (getAvatarMeta): no outer gate, must be covered ──────────

describe('per-attempt deadline gate for avatar metadata (getAvatarMeta)', () => {
  it('rejects at 0ms remaining without invoking the resolver', async () => {
    const getMetadata = vi.fn(async () => null);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(0, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('rejects at 999ms remaining without invoking the resolver', async () => {
    const getMetadata = vi.fn(async () => null);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(999, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('allows one attempt at exactly 1000ms remaining', async () => {
    const getMetadata = vi.fn(async () => null);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(1000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getMetadata).toHaveBeenCalledTimes(1);
  });

  it('invokes the resolver normally when ample time remains', async () => {
    const getMetadata = vi.fn(async () => null);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(10_000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getMetadata).toHaveBeenCalled();
  });
});

// ── Metadata legacy fallback gating ────────────────────────────────────────

describe('metadata legacy fallback per-attempt gating', () => {
  it('gates legacy metadata fallback when primary consumed time past the floor', async () => {
    const getMetadata = vi.fn(async () => {
      vi.advanceTimersByTime(1);
      return null;
    });
    const legacyGetMetadata = vi.fn(async () => null);
    const svc = makeService({ getMetadata }, { getMetadata: legacyGetMetadata });

    const out = await settle(inRequest(1000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(legacyGetMetadata).not.toHaveBeenCalled();
    expectDeadlineError(out.error);
  });
});

// ── Causal deadline bounding: hung work is killed by the deadline ──────────

describe('causal deadline bounding: hung work killed by request deadline', () => {
  it('avatar: hung resolver at exactly 1000ms is killed by deadline, not media timeout', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    // With exactly 1000ms remaining (< 8000ms media timeout), the deadline
    // must win the race and throw RequestDeadlineError.
    expectDeadlineError(out.error);
    // The resolver was invoked (admitted past the floor check), but the
    // deadline killed the hung work. Elapsed ~1000ms, not ~8000ms.
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(1050);
  });

  it('header: hung resolver at exactly 1000ms is killed by deadline', async () => {
    const getHeader = vi.fn(hung);
    const svc = makeService({ getHeader });

    const out = await settle(inRequest(1000, () => svc.getHeaderImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getHeader).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(1050);
  });

  it('avatar: hung resolver at 5000ms remaining (shorter than media timeout) is killed by deadline', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(5000, () => svc.getAvatarImage('budget.eth')), 60_000);

    // 5000ms < 8000ms: deadline wins, elapsed ~5000ms.
    expectDeadlineError(out.error);
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(5050);
  });
});

// ── Media timeout wins when shorter than deadline ──────────────────────────

describe('media timeout wins when shorter than remaining deadline', () => {
  it('avatar: hung resolver with ample time is killed by the 8s media timeout, not deadline', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(20_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    // 20s remaining > 8s media timeout: media timeout wins, throws UpstreamError.
    // It must NOT be a RequestDeadlineError.
    expect(out.error).toBeInstanceOf(UpstreamError);
    expect((out.error as Error).name).not.toBe('RequestDeadlineError');
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeGreaterThanOrEqual(7_950);
    expect(out.elapsed).toBeLessThanOrEqual(8_050);
  });

  it('header: hung resolver with ample time is killed by media timeout', async () => {
    const getHeader = vi.fn(hung);
    const svc = makeService({ getHeader });

    const out = await settle(inRequest(20_000, () => svc.getHeaderImage('budget.eth')), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect((out.error as Error).name).not.toBe('RequestDeadlineError');
    expect(out.elapsed).toBeLessThanOrEqual(8_050);
  });
});

// ── Work completing before both timeouts wins ──────────────────────────────

describe('work completing before both timeouts wins', () => {
  it('avatar: resolver completing in 100ms at 5000ms remaining returns normally', async () => {
    const getAvatar = vi.fn(afterMs(100, null));
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(5000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(150);
  });

  it('metadata: resolver completing in 100ms at 5000ms remaining returns normally', async () => {
    const getMetadata = vi.fn(afterMs(100, null));
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(5000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(150);
  });
});

// ── Deadline error type is exact RequestDeadlineError ──────────────────────

describe('deadline error type is exact RequestDeadlineError', () => {
  it('deadline rejection is instanceof RequestDeadlineError (not just UpstreamError)', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    // Must be specifically RequestDeadlineError, not a plain UpstreamError
    // with the same .name.
    expect(out.error).toBeInstanceOf(RequestDeadlineError);
    expect(out.error).toBeInstanceOf(UpstreamError); // subclass
  });

  it('media timeout is NOT RequestDeadlineError', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(20_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(out.error).not.toBeInstanceOf(RequestDeadlineError);
  });
});

// ── Each attempt individually bounded (hung primary, legacy never reached) ─

describe('each attempt individually bounded by returned deadline duration', () => {
  it('hung primary avatar is killed by its own deadline bound; legacy never reached', async () => {
    const getAvatar = vi.fn(hung);
    const legacyGetAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar }, { getAvatar: legacyGetAvatar });

    // Primary hung: the deadline kills it before it returns, so
    // withLegacyFallback never sees a result and never tries legacy.
    const out = await settle(inRequest(5000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(legacyGetAvatar).not.toHaveBeenCalled();
    expect(out.elapsed).toBeLessThanOrEqual(5050);
  });

  it('hung primary metadata is killed by deadline; legacy never reached', async () => {
    const getMetadata = vi.fn(hung);
    const legacyGetMetadata = vi.fn(hung);
    const svc = makeService({ getMetadata }, { getMetadata: legacyGetMetadata });

    const out = await settle(inRequest(5000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(legacyGetMetadata).not.toHaveBeenCalled();
  });
});

// ── Metadata: hung work bounded by deadline ────────────────────────────────

describe('metadata hung at deadline', () => {
  it('metadata: hung resolver at 1000ms is killed by deadline, not media timeout', async () => {
    const getMetadata = vi.fn(hung);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(1000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(1050);
  });

  it('metadata: hung resolver with ample time is killed by media timeout', async () => {
    const getMetadata = vi.fn(hung);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(20_000, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(out.error).not.toBeInstanceOf(RequestDeadlineError);
    expect(out.elapsed).toBeLessThanOrEqual(8_050);
  });
});

// ── Mutable-name impostor: deadline behavior is name-independent ───────────

describe('deadline behavior is name-independent (mutable-name impostor)', () => {
  it('different name gets same deadline rejection at 0ms', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(0, () => svc.getAvatarImage('other.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('different name gets same deadline rejection at 999ms with hung resolver', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(999, () => svc.getAvatarImage('other.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('different name with hung resolver at 1000ms is killed by deadline', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('other.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(out.elapsed).toBeLessThanOrEqual(1050);
  });
});

// ── Boundary precision: < vs <= ────────────────────────────────────────────

describe('boundary precision: < vs <=', () => {
  it('allows an attempt at exactly 1000ms (kills <=1000 mutation)', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });
});

// ── Deletion mutant kill ───────────────────────────────────────────────────

describe('deletion mutant kill', () => {
  it('rejects at 0ms on avatar (gate must exist)', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(0, () => svc.getAvatarImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('rejects at 0ms on metadata (gate must exist)', async () => {
    const getMetadata = vi.fn(async () => null);
    const svc = makeService({ getMetadata });

    const out = await settle(inRequest(0, () => svc.getAvatarMeta('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    expect(getMetadata).not.toHaveBeenCalled();
  });
});

// ── No retained timers after settlement (timer cleanup) ────────────────────

describe('no retained timers after settlement', () => {
  it('deadline win at 1000ms: no pending timers remain after settlement', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const before = vi.getTimerCount();
    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expectDeadlineError(out.error);
    // After settlement, zero timers should remain. The current product
    // leaves the nested withMediaTimeout 8s timer dangling.
    expect(vi.getTimerCount()).toBe(before);
  });

  it('media-timeout win: no pending timers remain after settlement', async () => {
    const getAvatar = vi.fn(hung);
    const svc = makeService({ getAvatar });

    const before = vi.getTimerCount();
    const out = await settle(inRequest(20_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(out.error).not.toBeInstanceOf(RequestDeadlineError);
    // raceRequestDeadline already clears its timer; withMediaTimeout must too.
    expect(vi.getTimerCount()).toBe(before);
  });

  it('early sync work success: no pending timers remain', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const before = vi.getTimerCount();
    const out = await settle(inRequest(10_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('async work success (100ms): no pending timers remain', async () => {
    const getAvatar = vi.fn(afterMs(100, null));
    const svc = makeService({ getAvatar });

    const before = vi.getTimerCount();
    const out = await settle(inRequest(10_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('sync throw: no pending timers remain', async () => {
    const err = new UpstreamError('sync fail');
    const getAvatar = vi.fn(() => { throw err; });
    const svc = makeService({ getAvatar });

    const before = vi.getTimerCount();
    const out = await settle(inRequest(10_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBe(err);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('async rejection (100ms): no pending timers remain', async () => {
    const err = new UpstreamError('async fail');
    const getAvatar = vi.fn(afterMs(100, Promise.reject(err)));
    // afterMs returns () => Promise that resolves with the value, so for
    // rejection we need a function that rejects.
    const rejectAfter = () => new Promise<never>((_, reject) => setTimeout(() => reject(err), 100));
    const getAvatar2 = vi.fn(rejectAfter);
    const svc = makeService({ getAvatar: getAvatar2 });

    const before = vi.getTimerCount();
    const out = await settle(inRequest(10_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeInstanceOf(UpstreamError);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('primary/legacy both paths complete: no pending timers remain', async () => {
    const getAvatar = vi.fn(afterMs(50, null));
    const legacyGetAvatar = vi.fn(afterMs(50, null));
    const svc = makeService({ getAvatar }, { getAvatar: legacyGetAvatar });

    const before = vi.getTimerCount();
    // Primary returns null at 50ms, legacy returns null at 50ms.
    const out = await settle(inRequest(10_000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    // Both primary and legacy resolve within budget; zero timers remain.
    expect(vi.getTimerCount()).toBe(before);
  });
});