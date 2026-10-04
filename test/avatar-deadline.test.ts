// W8-BUDGET-002 round-11 oracle: invocation-based once auto-removal.
// Wraps {once:true} callbacks so the tuple is removed only when the
// listener is actually invoked by the abort dispatch — not before.
// stopImmediatePropagation-skipped listeners and post-abort registrations
// with repeated abort() never invoke → tuples remain → cleanup fails.
// Removes the AbortController.prototype.abort hook; the wrapper handles
// all auto-removal per native EventTarget semantics.
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

interface ListenerTuple { signal: AbortSignal; type: string; callback: EventListenerOrEventListenerObject; capture: boolean; once: boolean; wrapper?: EventListener; }
let activeTuples: ListenerTuple[] = [];

function normCapture(o?: boolean | AddEventListenerOptions): boolean {
  if (o === true) return true; if (o === false || o === undefined) return false;
  return (o as AddEventListenerOptions).capture === true;
}
function normOnce(o?: boolean | AddEventListenerOptions): boolean {
  if (typeof o === 'object' && o !== null) return (o as AddEventListenerOptions).once === true;
  return false;
}
function findTuple(signal: AbortSignal, type: string, cb: EventListenerOrEventListenerObject, capture: boolean): number {
  return activeTuples.findIndex(t => t.signal === signal && t.type === type && t.callback === cb && t.capture === capture);
}

const origAdd = AbortSignal.prototype.addEventListener;
const origRemove = AbortSignal.prototype.removeEventListener;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  timeoutMsValues = []; activeTuples = [];

  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeoutMsValues.push(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return ctrl.signal;
  });

  vi.spyOn(AbortSignal.prototype, 'addEventListener')
    .mockImplementation(function (this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
      if (type === 'abort') {
        const cap = normCapture(options); const once = normOnce(options);
        const existing = findTuple(this, type, listener, cap);
        if (existing !== -1) {
          // Dedup: pass the same callback that native already has (wrapper for {once}).
          const eff = activeTuples[existing].wrapper || listener;
          return origAdd.call(this, type, eff, options);
        }
        const tuple: ListenerTuple = { signal: this, type, callback: listener, capture: cap, once };
        if (once) {
          // Wrap so the tuple is removed only when this exact listener is invoked.
          const sig = this;
          tuple.wrapper = function (this: AbortSignal, ev: Event) {
            const idx = findTuple(sig, type, listener, cap);
            if (idx !== -1) activeTuples.splice(idx, 1);
            if (typeof listener === 'function') (listener as EventListener).call(this, ev);
            else (listener as EventListenerObject).handleEvent(ev);
          } as EventListener;
          activeTuples.push(tuple);
          return origAdd.call(this, type, tuple.wrapper, options);
        }
        activeTuples.push(tuple);
      }
      return origAdd.call(this, type, listener, options);
    });
  vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    .mockImplementation(function (this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
      if (type === 'abort') {
        const idx = findTuple(this, type, listener, normCapture(options));
        if (idx !== -1) {
          const t = activeTuples[idx];
          activeTuples.splice(idx, 1);
          // Use the wrapper if one was registered for this {once} tuple.
          const effective = t.wrapper || listener;
          return origRemove.call(this, type, effective, options);
        }
      }
      return origRemove.call(this, type, listener, options);
    });

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function settle<T>(promise: Promise<T>, maxMs: number) {
  const o: { done: boolean; value?: T; error?: unknown; elapsed: number } = { done: false, elapsed: 0 };
  promise.then(v => { o.done = true; o.value = v; }, e => { o.done = true; o.error = e; });
  const s = Date.now(); await vi.advanceTimersByTimeAsync(0);
  while (!o.done && Date.now() - s < maxMs) await vi.advanceTimersByTimeAsync(50);
  o.elapsed = Date.now() - s; return o;
}

function expectDeadline(err: unknown) { expect(err).toBeInstanceOf(UpstreamError); expect((err as Error).name).toBe('RequestDeadlineError'); }
function expectNotDeadline(err: unknown) { expect(err).toBeDefined(); if (err instanceof UpstreamError) expect((err as Error).name).not.toBe('RequestDeadlineError'); }

function makeService(uri: string) {
  const svc = new AvatarService(RPC_URL, NETWORKS.mainnet.chain);
  (svc as any).resolver = { getAvatar: vi.fn().mockResolvedValue(uri), getHeader: vi.fn().mockResolvedValue(uri) };
  (svc as any).legacyResolver = undefined;
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
function assertAllRemoved() { expect(activeTuples).toEqual([]); }

// ------- prior oracles -------
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

// ------- invocation-based contract tests -------
describe('W8-BUDGET-002: tuple instrumentation contract', () => {
  it('deduplicates identical (signal,type,callback,capture)', () => {
    const s = new AbortController().signal; const cb = () => {};
    s.addEventListener('abort', cb); s.addEventListener('abort', cb);
    expect(activeTuples.length).toBe(1);
    s.removeEventListener('abort', cb); assertAllRemoved();
  });
  it('normalizes capture: true and {capture:true}', () => {
    const s = new AbortController().signal; const cb = () => {};
    s.addEventListener('abort', cb, true);
    s.removeEventListener('abort', cb, { capture: true });
    assertAllRemoved();
  });
  it('separate capture values', () => {
    const s = new AbortController().signal; const cb = () => {};
    s.addEventListener('abort', cb, false); s.addEventListener('abort', cb, true);
    expect(activeTuples.length).toBe(2);
    s.removeEventListener('abort', cb, false); s.removeEventListener('abort', cb, true);
    assertAllRemoved();
  });
  it('distinct callbacks', () => {
    const s = new AbortController().signal; const cb1=()=>{},cb2=()=>{};
    s.addEventListener('abort', cb1); s.addEventListener('abort', cb2);
    expect(activeTuples.length).toBe(2);
    s.removeEventListener('abort', cb1); s.removeEventListener('abort', cb2);
    assertAllRemoved();
  });
  it('distinct signals', () => {
    const s1=new AbortController().signal,s2=new AbortController().signal;const cb=()=>{};
    s1.addEventListener('abort', cb); s2.addEventListener('abort', cb);
    expect(activeTuples.length).toBe(2);
    s1.removeEventListener('abort', cb); s2.removeEventListener('abort', cb);
    assertAllRemoved();
  });
  it('idempotent removal', () => {
    const s=new AbortController().signal;const cb=()=>{};
    s.addEventListener('abort', cb);
    s.removeEventListener('abort', cb); s.removeEventListener('abort', cb);
    assertAllRemoved();
  });

  it('pre-dispatch {once} is auto-removed when listener is actually invoked', () => {
    const ctrl = new AbortController(); const s = ctrl.signal;
    let called = false;
    s.addEventListener('abort', () => { called = true; }, { once: true });
    ctrl.abort();
    expect(called).toBe(true);
    assertAllRemoved();
  });

  it('stopImmediatePropagation: skipped {once} listener NOT removed', () => {
    const ctrl = new AbortController(); const s = ctrl.signal;
    const cb1 = vi.fn((ev: Event) => { ev.stopImmediatePropagation(); });
    const cb2 = vi.fn();
    s.addEventListener('abort', cb1, { once: true });
    s.addEventListener('abort', cb2, { once: true });
    ctrl.abort();
    expect(cb1).toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    // cb2 was never invoked → tuple remains.
    expect(activeTuples.length).toBe(1);
    // cb2 must be explicitly removed.
    s.removeEventListener('abort', cb2);
    assertAllRemoved();
  });

  it('post-abort registration + repeated abort: listener never fires, tuple not removed', () => {
    const ctrl = new AbortController();
    ctrl.abort(); // signal already aborted
    const s = ctrl.signal;
    let called = false;
    s.addEventListener('abort', () => { called = true; }, { once: true });
    ctrl.abort(); // repeated abort — no dispatch
    expect(called).toBe(false);
    // Listener never invoked → tuple remains.
    expect(activeTuples.length).toBe(1);
    s.removeEventListener('abort', () => {}); // wrong callback
    expect(activeTuples.length).toBe(1); // still there
    // Correct removal.
    const cb = activeTuples[0].callback;
    s.removeEventListener('abort', cb as EventListener);
    assertAllRemoved();
  });

  it('post-abort + explicit remove with matching callback', () => {
    const ctrl = new AbortController(); ctrl.abort();
    const s = ctrl.signal; const cb = () => {};
    s.addEventListener('abort', cb, { once: true });
    s.removeEventListener('abort', cb);
    assertAllRemoved();
  });

  // Duplicate {once}: native deduplicates, invokes exactly once.
  it('duplicate {once} on same signal: native one invocation', () => {
    const ctrl = new AbortController(); const s = ctrl.signal;
    let calls = 0; const cb = () => { calls++; };
    s.addEventListener('abort', cb, { once: true });
    s.addEventListener('abort', cb, { once: true });
    ctrl.abort();
    expect(calls).toBe(1);
    assertAllRemoved();
  });

  // Cross-signal: same callback on two signals, remove from one.
  it('cross-signal: removal on A does not affect B', () => {
    const ca = new AbortController(); const cb = new AbortController();
    const sa = ca.signal; const sb = cb.signal;
    let aCalls = 0, bCalls = 0;
    const fn = () => { aCalls++; };
    const fnB = () => { bCalls++; };
    sa.addEventListener('abort', fn, { once: true });
    sb.addEventListener('abort', fnB, { once: true });
    sa.removeEventListener('abort', fn);
    ca.abort(); cb.abort();
    expect(aCalls).toBe(0); // removed before abort
    expect(bCalls).toBe(1); // still fires
    assertAllRemoved();
  });

  // Capture-specific: same callback with capture:true vs capture:false.
  it('capture-specific removal: only matching capture tuple removed', () => {
    const ctrl = new AbortController(); const s = ctrl.signal;
    let capTrue = 0, capFalse = 0;
    const cb = (ev: Event) => { if ((ev as any).__cap) capTrue++; else capFalse++; };
    s.addEventListener('abort', cb, { once: true });       // capture:false
    s.addEventListener('abort', cb, { once: true, capture: true } as any);
    s.removeEventListener('abort', cb); // removes capture:false
    ctrl.abort();
    // Only capture:true listener fired.
    expect(activeTuples.length).toBe(0); // both removed: false via explicit, true via dispatch
    assertAllRemoved();
  });

  // Stale wrapper: remove {once}, re-register without once.
  it('stale wrapper: remove {once}, re-register non-once, remove again', () => {
    const s = new AbortController().signal;
    const cb = () => {};
    s.addEventListener('abort', cb, { once: true });
    s.removeEventListener('abort', cb);
    s.addEventListener('abort', cb); // non-once re-registration
    s.removeEventListener('abort', cb);
    assertAllRemoved();
  });
});

// ------- lifecycle tests -------
describe('W8-BUDGET-002: listener lifecycle', () => {
  it('removes abort listener after work succeeds (avatar)', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => { vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-3000); await svc.getAvatarImage('test.eth'); });
    assertAllRemoved();
  });
  it('header succeed', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockResolvedValue(validPng());
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => { vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-3000); await svc.getHeaderImage('test.eth'); });
    assertAllRemoved();
  });
  it('sync rejection', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockRejectedValue(new Error('sync fail'));
    const b = await import('../src/services/request-budget');
    await b.withRequestBudget(async () => { vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-3000); await svc.getAvatarImage('test.eth').catch(()=>{}); });
    assertAllRemoved();
  });
  it('async signal-abort', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const b = await import('../src/services/request-budget');
    await settle(b.withRequestBudget(async () => { vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-2000); return svc.getAvatarImage('test.eth').catch(()=>{}); }), 10_000);
    assertAllRemoved();
  });
  it('16 concurrent', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    fm.mockImplementation(async()=>validPng());
    const b = await import('../src/services/request-budget');
    const r = await b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-5000);return Promise.all(Array.from({length:16},()=>svc.getAvatarImage('test.eth')));});
    expect(r).toHaveLength(16); for(const x of r) expect(x).not.toBeNull();
    assertAllRemoved();
  });
  it('initial-aborted', async () => {
    const { svc, fetchMock: fm } = makeService(MEDIA_URL);
    // Rejecting work: stronger than resolving — if the product fails to
    // suppress work rejection, a late unhandled rejection may surface.
    fm.mockRejectedValue(new Error('work rejected'));
    const b = await import('../src/services/request-budget');
    const origTo = AbortSignal.timeout;
    vi.spyOn(AbortSignal,'timeout').mockImplementation((ms:number)=>{const s=origTo(ms);Object.defineProperty(s,'aborted',{value:true,configurable:true});return s;});
    const e = await b.withRequestBudget(async()=>{vi.setSystemTime(Date.now()+b.REQUEST_DEADLINE_MS-2000);return svc.getAvatarImage('test.eth').catch((x:unknown)=>x);});
    expectDeadline(e); assertAllRemoved();
  });
});