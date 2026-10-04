import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mainnet } from 'viem/chains';
import { AvatarService } from '../src/services/avatar';
import { RequestDeadlineError } from '../src/services/errors';
import { withRequestBudget } from '../src/services/request-budget';

// W8-BUDGET-001: the request deadline must gate every upstream attempt including
// avatar/header resolver RPC work. When the deadline has passed, resolveMedia
// must throw RequestDeadlineError before invoking the resolver.

const DEADLINE_MS = 25_000;

type FakeResolver = { getAvatar?: Mock; getHeader?: Mock };

function makeService(primary: FakeResolver, legacy?: FakeResolver): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', mainnet);
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = legacy;
  return svc;
}

// Advance fake time in small steps until `promise` settles (or `maxMs` pass),
// draining the fake timer queue so vitest does not hang on pending timers.
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

describe('avatar resolver request deadline gate (W8-BUDGET-001)', () => {
  it('throws RequestDeadlineError before invoking the resolver when the request deadline has passed (0ms remaining)', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const result = withRequestBudget(() => {
      // Advance to the request deadline (0 ms remaining).
      vi.setSystemTime(Date.now() + DEADLINE_MS);
      return svc.getAvatarImage('budget.eth');
    });

    const out = await settle(result, 60_000);

    // Expected: RequestDeadlineError thrown. Actual (on BASE): null returned.
    // On the unfixed BASE, out.value will be null (the resolver was invoked).
    // After the fix, out.error will be a RequestDeadlineError.
    expect(out.error).toBeInstanceOf(RequestDeadlineError);

    // The resolver must not have been invoked — the deadline gate fires first.
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('throws RequestDeadlineError before invoking the header resolver when the request deadline has passed', async () => {
    const getHeader = vi.fn(async () => null);
    const svc = makeService({ getHeader });

    const result = withRequestBudget(() => {
      vi.setSystemTime(Date.now() + DEADLINE_MS);
      return svc.getHeaderImage('budget.eth');
    });

    const out = await settle(result, 60_000);

    expect(out.error).toBeInstanceOf(RequestDeadlineError);
    expect(getHeader).not.toHaveBeenCalled();
  });

  it('throws RequestDeadlineError with less than 1s remaining, before invoking the resolver', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    // 990 ms remaining: under the 1s floor in MIN_UPSTREAM_ATTEMPT_MS.
    const result = withRequestBudget(() => {
      vi.setSystemTime(Date.now() + DEADLINE_MS - 990);
      return svc.getAvatarImage('budget.eth');
    });

    const out = await settle(result, 60_000);

    expect(out.error).toBeInstanceOf(RequestDeadlineError);
    expect(getAvatar).not.toHaveBeenCalled();
  });

  it('invokes the resolver normally when time remains on the request deadline', async () => {
    const getAvatar = vi.fn(async () => null);
    const svc = makeService({ getAvatar });

    const result = withRequestBudget(() => {
      // 10s remaining: well within the budget.
      vi.setSystemTime(Date.now() + DEADLINE_MS - 10_000);
      return svc.getAvatarImage('budget.eth');
    });

    const out = await settle(result, 60_000);

    // With 10s left and a resolver that returns null (no avatar), the call
    // completes without an UpstreamError — the resolver was invoked and answered.
    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
    expect(getAvatar).toHaveBeenCalled();
  });
});