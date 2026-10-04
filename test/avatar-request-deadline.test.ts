import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mainnet } from 'viem/chains';
import { AvatarService } from '../src/services/avatar';
import { RequestDeadlineError, UpstreamError } from '../src/services/errors';
import { withRequestBudget } from '../src/services/request-budget';

// W8-BUDGET-001: the request deadline must gate every upstream attempt including
// avatar/header resolver RPC work AND metadata lookups, at the per-attempt
// boundary (lookup, immediately before work()). The one outer guard in
// resolveMedia lets legacy fallback attempts start after the primary consumed
// time past the 1000ms floor, and getAvatarMeta has no guard at all.

const DEADLINE_MS = 25_000;
const FIRST_UPSTREAM_ERROR = new UpstreamError('primary failed');

type FakeResolver = { getAvatar?: Mock; getHeader?: Mock; getMetadata?: Mock };

function makeService(primary: FakeResolver, legacy?: FakeResolver): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', mainnet);
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = legacy;
  return svc;
}

// Advance fake time in small steps until `promise` settles (or `maxMs` pass).
async function settle<T>(promise: Promise<T>, maxMs: number) {
  const outcome: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => { outcome.done = true; outcome.value = value; },
    (error) => { outcome.done = true; outcome.error = error; },
  );
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(0);
  while (!outcome.done && Date.now() - start < maxMs) {
    await vi.advanceTimersByTimeAsync(50);
  }
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
  expect(error).toBeInstanceOf(UpstreamError);
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

    // At exactly 1000ms, one attempt is allowed. The resolver returns null.
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
    // Primary returns null after consuming 1ms, leaving 999ms.
    const getAvatar = vi.fn(async () => {
      vi.advanceTimersByTime(1);
      return null;
    });
    const legacyGetAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar }, { getAvatar: legacyGetAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    // Primary was invoked (1000ms >= 1000ms). Legacy must not be invoked (999ms < 1000ms).
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(legacyGetAvatar).not.toHaveBeenCalled();
    // The overall call should fail: primary returned null (no avatar), legacy
    // was gated → withLegacyFallback sees null from both paths and returns null.
    // But the legacy attempt threw RequestDeadlineError internally. The question
    // is: does withLegacyFallback catch it and return null, or does it propagate?
    //
    // withLegacyFallback: primary returned null (no error caught in the try),
    // so primaryFailure is undefined. Then legacy lookup throws
    // RequestDeadlineError. The catch in withLegacyFallback is around the
    // primary call only. The legacy call is in a separate statement:
    //   const legacy = await lookup(this.legacyResolver);
    // An error there propagates out of withLegacyFallback.
    //
    // So the overall result should be a RequestDeadlineError.
    expectDeadlineError(out.error);
  });

  it('gates legacy fallback when primary (UpstreamError) consumed time past the floor', async () => {
    // Primary throws UpstreamError after consuming 1ms, leaving 999ms.
    const getAvatar = vi.fn(async () => {
      vi.advanceTimersByTime(1);
      throw FIRST_UPSTREAM_ERROR;
    });
    const legacyGetAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar }, { getAvatar: legacyGetAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    // Primary was invoked. Legacy must not be invoked.
    expect(getAvatar).toHaveBeenCalledTimes(1);
    expect(legacyGetAvatar).not.toHaveBeenCalled();
    // withLegacyFallback: primary threw UpstreamError (caught, primaryFailure set).
    // Then legacy lookup throws RequestDeadlineError. The await on legacy is
    // outside the primary's try/catch, so the error propagates.
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

// ── Mutation kill: boundary precision ──────────────────────────────────────

describe('boundary precision: < vs <=', () => {
  it('allows an attempt at exactly 1000ms (kills <=1000 mutation)', async () => {
    // If the check used <=1000 instead of <1000, this would reject. But the
    // invariant is "no new attempt starts with less than 1s left", so exactly
    // 1000ms IS allowed. A mutation to <=1000 would make this test fail.
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const out = await settle(inRequest(1000, () => svc.getAvatarImage('budget.eth')), 60_000);

    expect(out.error).toBeUndefined();
    expect(getAvatar).toHaveBeenCalledTimes(1);
  });
});

// ── Deletion mutant kill: no gate at all ───────────────────────────────────

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