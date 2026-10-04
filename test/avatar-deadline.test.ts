// W8-BUDGET-002: the request deadline must gate every media-host network
// attempt — the initial fetch AND every redirect hop. The fetch timeout must
// be bounded by remaining request time (not a fixed 7s), and deadline
// exhaustion must surface RequestDeadlineError rather than a generic error.
//
// This file is the blind acceptance test (oracle) committed before any fix code
// and independently proves each invariant fails at the current HEAD.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AvatarService } from '../src/services/avatar';
import { UpstreamError } from '../src/services/errors';
import { NETWORKS } from '../src/config/networks';

const MEDIA_URL = 'https://media.test/avatar/example.png';
const REDIRECT_URL = 'https://redirect.example/img.png';
const RPC_URL = 'https://rpc.test.example';

// 1x1 PNG base64 bytes (valid image).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Collect AbortSignal.timeout calls so tests can inspect the values.
let timeoutMsValues: number[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  timeoutMsValues = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeoutMsValues.push(ms);
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

// Advance fake time in small steps until `promise` settles (or `maxMs` pass).
async function settle<T>(promise: Promise<T>, maxMs: number) {
  const outcome: { done: boolean; value?: T; error?: unknown; elapsed: number } = { done: false, elapsed: 0 };
  promise.then(
    (v) => { outcome.done = true; outcome.value = v; },
    (e) => { outcome.done = true; outcome.error = e; },
  );
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(0);
  while (!outcome.done && Date.now() - start < maxMs) {
    await vi.advanceTimersByTimeAsync(50);
  }
  outcome.elapsed = Date.now() - start;
  return outcome;
}

function expectDeadlineError(error: unknown) {
  expect(error).toBeInstanceOf(UpstreamError);
  expect((error as Error).name).toBe('RequestDeadlineError');
}

// Build a bare AvatarService with a fake resolver that returns `uri`
// synchronously (no RPC). Stubs global fetch so the media path runs.
function makeService(uri: string): {
  svc: AvatarService;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const svc = new AvatarService(RPC_URL, NETWORKS.mainnet.chain);
  const fakeResolver = {
    getAvatar: vi.fn().mockResolvedValue(uri),
    getHeader: vi.fn().mockResolvedValue(uri),
  };
  (svc as unknown as { resolver: typeof fakeResolver }).resolver = fakeResolver;
  (svc as unknown as { legacyResolver?: typeof fakeResolver }).legacyResolver = undefined;

  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return { svc, fetchMock };
}

describe('W8-BUDGET-002: entry guard (existing)', () => {
  it('throws RequestDeadlineError before fetchMedia when less than 1s remains at entry', async () => {
    const { svc } = makeService(MEDIA_URL);

    // Mock fetchMedia on the instance to track whether it is called.
    // The guard must throw before fetchMedia starts.
    let fetchMediaCalled = false;
    (svc as unknown as { fetchMedia: typeof svc['fetchMedia'] }).fetchMedia = vi
      .fn()
      .mockImplementation(async () => {
        fetchMediaCalled = true;
        return null;
      });

    const budget = await import('../src/services/request-budget');

    const error = await budget.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 500);
      return svc.getAvatarImage('test.eth').catch((e: unknown) => e);
    });

    expect(fetchMediaCalled).toBe(false);
    expectDeadlineError(error);
  });
});

describe('W8-BUDGET-002: redirect-hop deadline gating', () => {
  it('throws RequestDeadlineError before a redirect hop when less than 1s remains', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    // First fetch: returns 302 to REDIRECT_URL after 600ms latency.
    // Second fetch (redirect hop): should not be reached.
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      return new Response(null, {
        status: 302,
        headers: { Location: REDIRECT_URL },
      });
    });
    // If reached, record it so the test can fail meaningfully.
    fetchMock.mockImplementationOnce(async () => {
      return new Response('SHOULD NOT REACH', { status: 200 });
    });

    const budget = await import('../src/services/request-budget');

    // Start with 1500ms remaining. The 600ms first hop leaves 900ms — below
    // the 1000ms minimum for a new attempt. The next hop must not start.
    // Let the promise reject naturally — settle captures rejections in .error.
    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 1500);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    // Only the initial URL must have been fetched.
    const urls = fetchMock.mock.calls.map((c: [RequestInfo | URL, ...unknown[]]) =>
      typeof c[0] === 'string' ? c[0] : c[0] instanceof URL ? c[0].href : String(c[0]),
    );
    expect(urls).toEqual([MEDIA_URL]);

    // The error must be RequestDeadlineError, not a generic UpstreamError
    // or a response from the redirect URL.
    expectDeadlineError(out.error);
  });

  it('gates a header-image redirect hop the same way', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      return new Response(null, { status: 302, headers: { Location: REDIRECT_URL } });
    });
    fetchMock.mockImplementationOnce(async () => {
      return new Response('SHOULD NOT REACH', { status: 200 });
    });

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 1500);
        return svc.getHeaderImage('test.eth');
      }),
      60_000,
    );

    const urls = fetchMock.mock.calls.map((c: [RequestInfo | URL, ...unknown[]]) =>
      typeof c[0] === 'string' ? c[0] : c[0] instanceof URL ? c[0].href : String(c[0]),
    );
    expect(urls).toEqual([MEDIA_URL]);
    expectDeadlineError(out.error);
  });
});

describe('W8-BUDGET-002: fetch timeout bounded by remaining request time', () => {
  it('uses a timeout ≤ remaining request time, not the fixed 7s cap', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    // Return a valid PNG immediately so the fetch completes.
    const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
    fetchMock.mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }));

    const budget = await import('../src/services/request-budget');

    // Inside a request with only 2000ms remaining. The fetch timeout must be
    // min(7000, 2000) = 2000, not 7000.
    await budget.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
      await svc.getAvatarImage('test.eth');
    });

    // Collect AbortSignal.timeout values that belong to the media fetch
    // (non-zero, ≤ the 7s cap). Inside the request the value must be ≤ 2000.
    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    expect(relevant.length).toBeGreaterThan(0);

    // No timeout should exceed the remaining request time (2000ms).
    for (const t of relevant) {
      expect(t).toBeLessThanOrEqual(2000);
    }
    // At least one timeout must be strictly less than the fixed 7000ms cap.
    expect(relevant.some((t) => t < 7000)).toBe(true);
  });

  it('uses the full 7s cap outside a request', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
    fetchMock.mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }));

    // Outside a request: no budget, timeout should be the full 7s.
    await svc.getAvatarImage('test.eth');

    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    // The timeout should be 7000 (or very close).
    expect(relevant.some((t) => t >= 6900)).toBe(true);
  });
});

describe('W8-BUDGET-002: deadline exhaustion surfaces RequestDeadlineError', () => {
  it('throws RequestDeadlineError, not a generic UpstreamError, when the fetch runs past the deadline', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    // The fetch hangs but respects the abort signal — the bounded timeout
    // fires and the signal aborts the fetch.
    fetchMock.mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2500);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    // The error must be RequestDeadlineError specifically.
    expectDeadlineError(out.error);
    // The error message must reference the deadline, not a generic timeout.
    expect((out.error as Error).message).toContain('deadline');
  });
});