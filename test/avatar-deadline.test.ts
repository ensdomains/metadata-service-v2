// W8-BUDGET-002: the request deadline must gate the media-host fetch after
// avatar/header resolution. No new upstream attempt may start with less than
// MIN_UPSTREAM_ATTEMPT_MS (1s) left.
//
// This file is the blind acceptance test (oracle) — it tests each lane's
// implementation against the ticket's own interface and is committed before
// any fix code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AvatarService } from '../src/services/avatar';
import { UpstreamError } from '../src/services/errors';
import { NETWORKS } from '../src/config/networks';

const MEDIA_URL = 'https://media.test/avatar/example.png';
const RPC_URL = 'https://rpc.test.example';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('W8-BUDGET-002: media-host fetch gated by request deadline', () => {
  it('throws RequestDeadlineError before fetchMedia when less than 1s remains', async () => {
    const svc = new AvatarService(RPC_URL, NETWORKS.mainnet.chain);
    const fakeResolver = {
      getAvatar: vi.fn().mockResolvedValue(MEDIA_URL),
      getHeader: vi.fn().mockResolvedValue(MEDIA_URL),
    };
    (svc as unknown as { resolver: typeof fakeResolver }).resolver = fakeResolver;
    (svc as unknown as { legacyResolver?: typeof fakeResolver }).legacyResolver = undefined;

    // Replace fetchMedia on the instance to track whether it is called.
    // The guard (timeLeftForAttempt) must throw before fetchMedia starts.
    let fetchMediaCalled = false;
    (svc as unknown as { fetchMedia: typeof svc['fetchMedia'] }).fetchMedia = vi
      .fn()
      .mockImplementation(async () => {
        fetchMediaCalled = true;
        return null;
      });

    // Import the budget helpers dynamically so the test stays self-contained.
    const budget = await import('../src/services/request-budget');

    // With a request deadline that leaves only 500ms — well below the 1s
    // minimum — the record resolution returns immediately (the fake resolver
    // is synchronous), but timeLeftForAttempt at the fetchMedia call site must
    // see the exhausted deadline and throw.
    const error = await budget.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 500);
      return svc.getAvatarImage('test.eth').catch((e: unknown) => e);
    });

    // The media fetch must NOT have been started.
    expect(fetchMediaCalled).toBe(false);

    // A RequestDeadlineError must have been thrown.
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).name).toBe('RequestDeadlineError');
  });
});