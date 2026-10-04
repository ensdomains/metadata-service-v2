// W8-BUDGET-002: the request deadline must gate every media-host network
// attempt.  The signal-abort event itself — not an after-the-fact error
// identity check — must produce RequestDeadlineError via a causal race,
// so whichever settles first controls and unrelated late errors are
// never mislabeled.  This file is the blind oracle committed before the
// round-5 product correction and independently proves the failures.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AvatarService } from '../src/services/avatar';
import { UpstreamError } from '../src/services/errors';
import { NETWORKS } from '../src/config/networks';

const MEDIA_URL   = 'https://media.test/avatar/example.png';
const REDIRECT_URL = 'https://redirect.example/img.png';
const RPC_URL      = 'https://rpc.test.example';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let timeoutMsValues: number[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  timeoutMsValues = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeoutMsValues.push(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return ctrl.signal;
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

async function settle<T>(promise: Promise<T>, maxMs: number) {
  const o: { done: boolean; value?: T; error?: unknown; elapsed: number } = { done: false, elapsed: 0 };
  promise.then(v => { o.done = true; o.value = v; }, e => { o.done = true; o.error = e; });
  const s = Date.now();
  await vi.advanceTimersByTimeAsync(0);
  while (!o.done && Date.now() - s < maxMs) await vi.advanceTimersByTimeAsync(50);
  o.elapsed = Date.now() - s;
  return o;
}

function expectDeadline(err: unknown) {
  expect(err).toBeInstanceOf(UpstreamError);
  expect((err as Error).name).toBe('RequestDeadlineError');
}
function expectNotDeadline(err: unknown) {
  expect(err).toBeDefined();
  if (err instanceof UpstreamError) expect((err as Error).name).not.toBe('RequestDeadlineError');
}

function makeService(uri: string) {
  const svc = new AvatarService(RPC_URL, NETWORKS.mainnet.chain);
  const fake = { getAvatar: vi.fn().mockResolvedValue(uri), getHeader: vi.fn().mockResolvedValue(uri) };
  (svc as any).resolver = fake;
  (svc as any).legacyResolver = undefined;
  const fm = vi.fn(); vi.stubGlobal('fetch', fm);
  return { svc, fetchMock: fm };
}

function fetchUrls(m: ReturnType<typeof vi.fn>): string[] {
  return m.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : c[0] instanceof URL ? c[0].href : String(c[0]));
}

function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const s = init?.signal;
    if (s?.aborted) { reject(s.reason); return; }
    s?.addEventListener('abort', () => reject(s.reason), { once: true });
  });
}

function validPng() {
  return new Response(Uint8Array.from(atob(PNG_BASE64), c => c.charCodeAt(0)),
    { status: 200, headers: { 'Content-Type': 'image/png' } });
}

// --------------- unchanged oracles (must keep passing) ---------------

describe('W8-BUDGET-002: entry guard', () => {
  it('throws RequestDeadlineError before fetchMedia when <1s at entry', async () => {
    const { svc } = makeService(MEDIA_URL);
    let called = false;
    (svc as any).fetchMedia = vi.fn().mockImplementation(async () => { called = true; return null; });
    const b = await import('../src/services/request-budget');
    const e = await b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 500);
      return svc.getAvatarImage('test.eth').catch((x: unknown) => x);
    });
    expect(called).toBe(false);
    expectDeadline(e);
  });
});

describe('W8-BUDGET-002: redirect-hop deadline gating', () => {
  it('blocks redirect hop when <1s remains', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(async () => { await new Promise(r => setTimeout(r, 600)); return new Response(null, { status: 302, headers: { Location: REDIRECT_URL } }); });
    fm.mockImplementationOnce(async () => new Response('NO', { status: 200 }));
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 1500); return svc.getAvatarImage('test.eth'); }), 60_000);
    expect(fetchUrls(fm)).toEqual([MEDIA_URL]);
    expectDeadline(o.error);
  });
  it('blocks header redirect hop the same', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(async () => { await new Promise(r => setTimeout(r, 600)); return new Response(null, { status: 302, headers: { Location: REDIRECT_URL } }); });
    fm.mockImplementationOnce(async () => new Response('NO', { status: 200 }));
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 1500); return svc.getHeaderImage('test.eth'); }), 60_000);
    expect(fetchUrls(fm)).toEqual([MEDIA_URL]);
    expectDeadline(o.error);
  });
});

describe('W8-BUDGET-002: timeout bounded by remaining time', () => {
  it('≤ remaining (2s), not fixed 7s', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000); await svc.getAvatarImage('test.eth'); });
    const r = timeoutMsValues.filter(t => t > 0 && t <= 7000);
    expect(r.length).toBeGreaterThan(0);
    for (const t of r) expect(t).toBeLessThanOrEqual(2000);
    expect(r.some(t => t < 7000)).toBe(true);
  });
  it('full 7s cap outside request', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    await svc.getAvatarImage('test.eth');
    expect(timeoutMsValues.filter(t => t >= 6900).length).toBeGreaterThan(0);
  });
});

describe('W8-BUDGET-002: deadline-driven fetch → RequestDeadlineError', () => {
  it('deadline cut produces RequestDeadlineError', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(hangingFetch);
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2500); return svc.getAvatarImage('test.eth'); }), 60_000);
    expectDeadline(o.error);
    expect((o.error as Error).message).toContain('deadline');
  });
});

describe('W8-BUDGET-002: media-cap timeout NOT RequestDeadlineError', () => {
  it('ample budget avatar', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(hangingFetch);
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 18_000); return svc.getAvatarImage('test.eth'); }), 60_000);
    expectNotDeadline(o.error);
  });
  it('ample budget header', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(hangingFetch);
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 18_000); return svc.getHeaderImage('test.eth'); }), 60_000);
    expectNotDeadline(o.error);
  });
});

describe('W8-BUDGET-002: 6999 / 7000 / 7001 boundary', () => {
  it('6999→6999ms + deadline-driven', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(hangingFetch);
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 6999); return svc.getAvatarImage('test.eth'); }), 60_000);
    expect(timeoutMsValues.filter(t => t > 0 && t <= 7000)).toContain(6999);
    expectDeadline(o.error);
  });
  it('7000→7000ms, media-cap tie (not deadline-driven)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(hangingFetch);
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 7000); return svc.getAvatarImage('test.eth'); }), 60_000);
    expect(timeoutMsValues.filter(t => t > 0 && t <= 7000)).toContain(7000);
    expectNotDeadline(o.error);
  });
  it('7001→7000ms (media cap wins)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(hangingFetch);
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 7001); return svc.getAvatarImage('test.eth'); }), 60_000);
    expect(timeoutMsValues.filter(t => t > 0 && t <= 7000)).toContain(7000);
    expectNotDeadline(o.error);
  });
});

// --------------- new / updated causal-timing oracles ---------------

describe('W8-BUDGET-002: unrelated operation error preserved (not from signal)', () => {
  it('initial-fetch throws TimeoutError before signal fires — preserved (avatar)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000); return svc.getAvatarImage('test.eth'); }), 60_000);
    expectNotDeadline(o.error);
  });
  it('initial-fetch TimeoutError before signal — preserved (header)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000); return svc.getHeaderImage('test.eth'); }), 60_000);
    expectNotDeadline(o.error);
  });
  it('body-stream throws TimeoutError before signal fires — preserved', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const mf = await import('../src/services/media-fetch');
    vi.spyOn(mf, 'readBodyCapped').mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000); return svc.getAvatarImage('test.eth'); }), 60_000);
    expectNotDeadline(o.error);
  });
});

describe('W8-BUDGET-002: signal-abort event wins causal race over hanging body', () => {
  // Causal timing: the body read hangs forever; the signal abort fires first,
  // so the race must produce RequestDeadlineError immediately.  The old
  // catch-based approach cannot handle this because no error is ever thrown
  // from within the IIFE — it simply hangs until the test times out.

  it('avatar: hanging body, signal abort wins → RequestDeadlineError', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const mf = await import('../src/services/media-fetch');
    vi.spyOn(mf, 'readBodyCapped').mockImplementation(() => new Promise(() => {})); // hangs forever
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000); return svc.getAvatarImage('test.eth'); }), 10_000);
    expectDeadline(o.error);
  });

  it('header: hanging body, signal abort wins → RequestDeadlineError', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const mf = await import('../src/services/media-fetch');
    vi.spyOn(mf, 'readBodyCapped').mockImplementation(() => new Promise(() => {}));
    const b = await import('../src/services/request-budget');
    const o = await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000); return svc.getHeaderImage('test.eth'); }), 10_000);
    expectDeadline(o.error);
  });
});