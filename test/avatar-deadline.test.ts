// W8-BUDGET-002 round-7 oracle: identity-sensitive listener lifecycle.
// Tracks exact callback identity via add/remove Sets; verifies that
// every registered abort callback is removed by the product code.
// A mutant that calls removeEventListener with a different callback
// (e.g. () => {}) must fail while correct code passes all tests.
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
let addedCbs:    Set<EventListenerOrEventListenerObject>;
let removedCbs:  Set<EventListenerOrEventListenerObject>;

const origAdd = AbortSignal.prototype.addEventListener;
const origRemove = AbortSignal.prototype.removeEventListener;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  timeoutMsValues = [];
  addedCbs = new Set();
  removedCbs = new Set();

  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeoutMsValues.push(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return ctrl.signal;
  });

  vi.spyOn(AbortSignal.prototype, 'addEventListener')
    .mockImplementation(function (this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
      if (type === 'abort') addedCbs.add(listener);
      return origAdd.call(this, type, listener, options);
    });
  vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    .mockImplementation(function (this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
      if (type === 'abort') removedCbs.add(listener);
      return origRemove.call(this, type, listener, options);
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

function expectDeadline(err: unknown) { expect(err).toBeInstanceOf(UpstreamError); expect((err as Error).name).toBe('RequestDeadlineError'); }
function expectNotDeadline(err: unknown) { expect(err).toBeDefined(); if (err instanceof UpstreamError) expect((err as Error).name).not.toBe('RequestDeadlineError'); }

function makeService(uri: string) {
  const svc = new AvatarService(RPC_URL, NETWORKS.mainnet.chain);
  const fake = { getAvatar: vi.fn().mockResolvedValue(uri), getHeader: vi.fn().mockResolvedValue(uri) };
  (svc as any).resolver = fake; (svc as any).legacyResolver = undefined;
  const fm = vi.fn(); vi.stubGlobal('fetch', fm);
  return { svc, fetchMock: fm };
}
function fetchUrls(m: ReturnType<typeof vi.fn>): string[] {
  return m.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : c[0] instanceof URL ? c[0].href : String(c[0]));
}
function validPng() { return new Response(Uint8Array.from(atob(PNG_BASE64), c => c.charCodeAt(0)), { status: 200, headers: { 'Content-Type': 'image/png' } }); }

function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const s = init?.signal; if (s?.aborted) { reject(s.reason); return; }
    s?.addEventListener('abort', () => reject(s.reason), { once: true });
  });
}

// Assert every added abort callback was removed (identity match).
function assertAllRemoved() {
  for (const cb of addedCbs) {
    expect(removedCbs.has(cb)).toBe(true);
  }
}

// ------- prior oracles (compressed, unchanged) -------

describe('W8-BUDGET-002: prior oracles', () => {
  it('entry guard', async () => {
    const { svc } = makeService(MEDIA_URL); let c=false; (svc as any).fetchMedia=vi.fn().mockImplementation(async()=>{c=true;return null;});
    const b=await import('../src/services/request-budget'); const e=await b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-500);return svc.getAvatarImage('test.eth').catch((x:unknown)=>x);});
    expect(c).toBe(false); expectDeadline(e);
  });
  it('redirect hop blocked', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(async()=>{await new Promise(r=>setTimeout(r,600));return new Response(null,{status:302,headers:{Location:REDIRECT_URL}});});
    fm.mockImplementationOnce(async()=>new Response('NO',{status:200}));
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-1500);return svc.getAvatarImage('test.eth');}),60_000);
    expect(fetchUrls(fm)).toEqual([MEDIA_URL]); expectDeadline(o.error);
  });
  it('6999→deadline', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockImplementationOnce(hangingFetch);
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-6999);return svc.getAvatarImage('test.eth');}),60_000);
    expect(timeoutMsValues.filter(t=>t>0&&t<=7000)).toContain(6999); expectDeadline(o.error);
  });
  it('7000→media-cap tie', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockImplementationOnce(hangingFetch);
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-7000);return svc.getAvatarImage('test.eth');}),60_000);
    expectNotDeadline(o.error);
  });
  it('7001→media-cap', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockImplementationOnce(hangingFetch);
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-7001);return svc.getAvatarImage('test.eth');}),60_000);
    expectNotDeadline(o.error);
  });
  it('media-cap ample', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockImplementationOnce(hangingFetch);
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-18_000);return svc.getAvatarImage('test.eth');}),60_000);
    expectNotDeadline(o.error);
  });
  it('unrelated fetch error preserved', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockRejectedValue(new DOMException('The operation timed out.','TimeoutError'));
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-2000);return svc.getAvatarImage('test.eth');}),60_000);
    expectNotDeadline(o.error);
  });
  it('unrelated body error preserved', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockResolvedValue(validPng());
    const mf=await import('../src/services/media-fetch'); vi.spyOn(mf,'readBodyCapped').mockRejectedValue(new DOMException('The operation timed out.','TimeoutError'));
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-2000);return svc.getAvatarImage('test.eth');}),60_000);
    expectNotDeadline(o.error);
  });
  it('hanging body abort wins avatar', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockResolvedValue(validPng());
    const mf=await import('../src/services/media-fetch'); vi.spyOn(mf,'readBodyCapped').mockImplementation(()=>new Promise(()=>{}));
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-2000);return svc.getAvatarImage('test.eth');}),10_000);
    expectDeadline(o.error);
  });
  it('hanging body abort wins header', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL); fm.mockResolvedValue(validPng());
    const mf=await import('../src/services/media-fetch'); vi.spyOn(mf,'readBodyCapped').mockImplementation(()=>new Promise(()=>{}));
    const b=await import('../src/services/request-budget'); const o=await settle(b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-2000);return svc.getHeaderImage('test.eth');}),10_000);
    expectDeadline(o.error);
  });
});

// ------- identity-sensitive listener-lifecycle tests -------

describe('W8-BUDGET-002: listener lifecycle — callback identity', () => {
  it('removes exact abort callback after work succeeds (avatar)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 3000);
      await svc.getAvatarImage('test.eth');
    });
    assertAllRemoved();
  });

  it('removes exact abort callback after work succeeds (header)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 3000);
      await svc.getHeaderImage('test.eth');
    });
    assertAllRemoved();
  });

  it('removes exact abort callback after synchronous rejection', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockRejectedValue(new Error('sync fail'));
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 3000);
      await svc.getAvatarImage('test.eth').catch(() => {});
    });
    assertAllRemoved();
  });

  it('removes exact abort callback after asynchronous (signal-abort) rejection', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    // Hang without registering any listener — the race's abortPromise wins.
    fm.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const b = await import('../src/services/request-budget');
    await settle(b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000);
      return svc.getAvatarImage('test.eth').catch(() => {});
    }), 10_000);
    assertAllRemoved();
  });

  it('16 concurrent successes: every added callback removed by identity', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementation(async () => validPng());
    const b = await import('../src/services/request-budget');
    const results = await b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 5000);
      return Promise.all(Array.from({ length: 16 }, () => svc.getAvatarImage('test.eth')));
    });
    expect(results).toHaveLength(16);
    for (const r of results) expect(r).not.toBeNull();
    // Every callback that was registered must appear in the removed set.
    assertAllRemoved();
    expect(addedCbs.size).toBe(16);
  });

  it('does not register a listener on an already-aborted signal', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const b = await import('../src/services/request-budget');
    // Simulate an already-aborted signal.
    const origTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const s = origTimeout(ms);
      Object.defineProperty(s, 'aborted', { value: true, configurable: true });
      return s;
    });
    const error = await b.withRequestBudget(async () => {
      vi.setSystemTime(Date.now() + b.REQUEST_DEADLINE_MS - 2000);
      return svc.getAvatarImage('test.eth').catch((e: unknown) => e);
    });
    expectDeadline(error);
    // No listener should have been added.
    expect(addedCbs.size).toBe(0);
  });
});