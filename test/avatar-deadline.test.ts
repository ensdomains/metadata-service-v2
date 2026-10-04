// W8-BUDGET-002: the request deadline must gate every media-host network
// attempt — the initial fetch AND every redirect hop. The fetch timeout must
// be bounded by remaining request time (not a fixed 7s), and deadline
// exhaustion must surface RequestDeadlineError rather than a generic error.
//
// This file is the blind acceptance test (oracle) committed before any fix
// code and independently proves each invariant fails at the current HEAD.
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

function expectNotDeadlineError(error: unknown) {
  expect(error).toBeDefined();
  if (error instanceof UpstreamError) {
    expect((error as Error).name).not.toBe('RequestDeadlineError');
  }
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

// Helper: extract URL strings from mock call args.
function fetchUrls(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((c) =>
    typeof c[0] === 'string' ? c[0] : c[0] instanceof URL ? c[0].href : String(c[0]),
  );
}

// A fetch mock that respects the abort signal — hangs until the signal fires.
function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function validPngResponse(): Response {
  const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

// --- Existing tests (unchanged) ---

describe('W8-BUDGET-002: entry guard (existing)', () => {
  it('throws RequestDeadlineError before fetchMedia when less than 1s remains at entry', async () => {
    const { svc } = makeService(MEDIA_URL);

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
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    expect(fetchUrls(fetchMock)).toEqual([MEDIA_URL]);
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

    expect(fetchUrls(fetchMock)).toEqual([MEDIA_URL]);
    expectDeadlineError(out.error);
  });
});

describe('W8-BUDGET-002: fetch timeout bounded by remaining request time', () => {
  it('uses a timeout ≤ remaining request time, not the fixed 7s cap', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockResolvedValue(validPngResponse());

    const budget = await import('../src/services/request-budget');

    await budget.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
      await svc.getAvatarImage('test.eth');
    });

    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    expect(relevant.length).toBeGreaterThan(0);
    for (const t of relevant) {
      expect(t).toBeLessThanOrEqual(2000);
    }
    expect(relevant.some((t) => t < 7000)).toBe(true);
  });

  it('uses the full 7s cap outside a request', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockResolvedValue(validPngResponse());

    await svc.getAvatarImage('test.eth');

    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    expect(relevant.some((t) => t >= 6900)).toBe(true);
  });
});

describe('W8-BUDGET-002: deadline exhaustion surfaces RequestDeadlineError', () => {
  it('throws RequestDeadlineError when a deadline-driven timeout cuts the fetch', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockImplementationOnce(hangingFetch);

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2500);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    expectDeadlineError(out.error);
    expect((out.error as Error).message).toContain('deadline');
  });
});

// --- New/updated tests for signal attribution and boundaries ---

describe('W8-BUDGET-002: signal-attributed conversion (not unrelated TimeoutError)', () => {
  it('does NOT convert an unrelated TimeoutError to RequestDeadlineError during initial fetch (avatar)', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    // Reject immediately with a TimeoutError that is NOT from our signal.
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    // The error must exist but NOT be RequestDeadlineError (signal not aborted).
    expectNotDeadlineError(out.error);
  });

  it('does NOT convert an unrelated TimeoutError during initial fetch (header)', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
        return svc.getHeaderImage('test.eth');
      }),
      60_000,
    );

    expectNotDeadlineError(out.error);
  });
});

describe('W8-BUDGET-002: media-cap timeout distinct from request-deadline timeout', () => {
  it('does NOT convert a media-cap timeout to RequestDeadlineError when budget is ample (avatar)', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockImplementationOnce(hangingFetch);

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 18_000);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    expectNotDeadlineError(out.error);
  });

  it('does NOT convert a media-cap timeout for header either', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockImplementationOnce(hangingFetch);

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 18_000);
        return svc.getHeaderImage('test.eth');
      }),
      60_000,
    );

    expectNotDeadlineError(out.error);
  });
});

describe('W8-BUDGET-002: deadline-driven timeout during body streaming', () => {
  it('converts a signal-attributed TimeoutError during body read to RequestDeadlineError (avatar)', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);

    // Fetch returns valid response immediately (only headers).
    fetchMock.mockResolvedValue(validPngResponse());

    // Advance past the signal timeout so signal.aborted is true, then
    // readBodyCapped throws a TimeoutError matching the signal's reason.
    const mf = await import('../src/services/media-fetch');
    vi.spyOn(mf, 'readBodyCapped').mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(2500); // past the 2s timeout
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    expectDeadlineError(out.error);
  });

  it('converts a signal-attributed body-stream TimeoutError for header too', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockResolvedValue(validPngResponse());

    const mf = await import('../src/services/media-fetch');
    vi.spyOn(mf, 'readBodyCapped').mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(2500);
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
        return svc.getHeaderImage('test.eth');
      }),
      60_000,
    );

    expectDeadlineError(out.error);
  });

  it('does NOT convert an unrelated body-stream TimeoutError when the signal is not aborted', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockResolvedValue(validPngResponse());

    const mf = await import('../src/services/media-fetch');
    // Throw immediately — no timer advancement, signal still un-aborted.
    vi.spyOn(mf, 'readBodyCapped').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 2000);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    expectNotDeadlineError(out.error);
  });
});

describe('W8-BUDGET-002: exact boundary 6999/7000/7001 timeout and attribution', () => {
  it('at 6999ms remaining: uses timeout 6999 and deadline-driven conversion fires', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockImplementationOnce(hangingFetch);

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 6999);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    // Timeout must be 6999 (not 7000).
    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    expect(relevant).toContain(6999);
    expect(relevant).not.toContain(7000);

    // 6999 < 7000 → deadlineDriven → RequestDeadlineError.
    expectDeadlineError(out.error);
  });

  it('at 7000ms remaining: uses timeout 7000 but deadlineDriven is false', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockImplementationOnce(hangingFetch);

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 7000);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    // Timeout must be 7000 (left=7000, min(7000,7000)=7000).
    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    expect(relevant).toContain(7000);

    // 7000 is NOT < 7000 → NOT deadlineDriven → NOT RequestDeadlineError.
    expectNotDeadlineError(out.error);
  });

  it('at 7001ms remaining: uses timeout 7000 (media cap wins), not deadline-driven', async () => {
    const { svc, fetchMock } = makeService(MEDIA_URL);
    fetchMock.mockImplementationOnce(hangingFetch);

    const budget = await import('../src/services/request-budget');

    const out = await settle(
      budget.withRequestBudget(async () => {
        vi.setSystemTime(Date.now() + budget.REQUEST_DEADLINE_MS - 7001);
        return svc.getAvatarImage('test.eth');
      }),
      60_000,
    );

    const relevant = timeoutMsValues.filter((t) => t > 0 && t <= 7000);
    expect(relevant).toContain(7000);

    expectNotDeadlineError(out.error);
  });
});