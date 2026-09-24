// Per-request budget for work that attacker-chosen contracts can fan out.
//
// A CCIP-read lookup through viem's local batch gateway (`x-batch-gateway:true`)
// calls the gateway request once per query in the batch, concurrently, and keeps
// every response until the whole batch is encoded. The number of queries comes
// from the contract, so a per-response cap alone does not bound the memory one
// lookup can hold. The budget is scoped to the incoming HTTP request with
// AsyncLocalStorage (available under nodejs_compat, and carried into waitUntil
// work), so every gateway response read while serving one request draws from
// the same allowance.
//
// Bytes alone do not bound the work, so the budget also counts:
//  - gateway fetches, redirect hops included, since one batch sends as many
//    requests as it has queries and each can follow up to 10 redirects;
//  - OffchainLookup turns. viem follows OffchainLookup recursively with no
//    depth limit: when the callback reverts with another OffchainLookup it
//    calls the gateway (or the local batch gateway, which with no queries sends
//    nothing) and then the contract again. A contract can keep one lookup
//    looping on tiny or no gateway responses, one RPC eth_call per turn, until
//    the Worker hits its subrequest limit.
//
// The budget also carries the request's deadline (WEB-1552). The global timeout
// (src/index.ts) answers 504 after 30s but does not stop the work behind it,
// while the RPC clients (primary plus fallbacks) and the indexer (retry plus
// fallback endpoint) each stack their own per-attempt timeouts. Every attempt
// now checks the deadline before it starts and is bounded by what is left of
// it, so a degraded upstream ends the request in an UpstreamError (503) before
// the global timeout. Work handed to waitUntil keeps the request's deadline,
// as it keeps its CCIP allowance.
import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestDeadlineError } from './errors';

export const MAX_CCIP_BYTES_PER_REQUEST = 8 * 1024 * 1024;
// A real lookup takes one or two turns and one gateway request per turn, and a
// request reads a handful of records.
export const MAX_CCIP_REQUESTS_PER_REQUEST = 32;
export const MAX_OFFCHAIN_LOOKUPS_PER_REQUEST = 32;
// Comfortably under the 30s global timeout, leaving time to answer with a 503.
export const REQUEST_DEADLINE_MS = 25_000;
// An RPC or indexer round trip takes a few hundred ms; with less than this
// left, an attempt would only delay the 503.
export const MIN_UPSTREAM_ATTEMPT_MS = 1_000;

interface RequestBudget {
  ccipBytes: number;
  ccipRequests: number;
  ccipExhausted: boolean;
  offchainLookups: number;
  /** Epoch ms after which no upstream work is started or awaited. */
  deadline: number;
}

const storage = new AsyncLocalStorage<RequestBudget>();

/** Run `fn` with a fresh budget (called once per incoming request). */
export function withRequestBudget<T>(fn: () => T): T {
  return storage.run(
    { ccipBytes: 0, ccipRequests: 0, ccipExhausted: false, offchainLookups: 0, deadline: Date.now() + REQUEST_DEADLINE_MS },
    fn,
  );
}

/**
 * Milliseconds left before this request's deadline (0 once it has passed).
 * Infinity outside a request (tests, scripts): no deadline applies there.
 */
export function remainingRequestTime(): number {
  const budget = storage.getStore();
  return budget ? Math.max(0, budget.deadline - Date.now()) : Number.POSITIVE_INFINITY;
}

/**
 * The time the next upstream attempt may take: what is left of this request's
 * deadline. Throws RequestDeadlineError (with `cause`, e.g. the previous
 * attempt's error) once less than MIN_UPSTREAM_ATTEMPT_MS is left.
 */
export function timeLeftForAttempt(what: string, cause?: unknown): number {
  const left = remainingRequestTime();
  if (left < MIN_UPSTREAM_ATTEMPT_MS) {
    throw new RequestDeadlineError(`Request deadline reached before ${what}`, { cause });
  }
  return left;
}

/**
 * Settle with `work`, or reject with RequestDeadlineError after `ms` (never
 * when `ms` is Infinity). For work that takes no AbortSignal: it is not
 * stopped, only no longer awaited.
 */
export function raceRequestDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestDeadlineError(`Request deadline reached during ${what}`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * fetch() that is also aborted at this request's deadline. viem's transports
 * take no per-call AbortSignal, but they call their fetchFn in the caller's
 * async context, so passing this as `fetchFn` threads the deadline into every
 * RPC fetch. A plain fetch outside a request.
 */
export function deadlineFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const left = remainingRequestTime();
  if (!Number.isFinite(left)) return fetch(input, init);
  const deadline = AbortSignal.timeout(left);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
}

/**
 * Take one OffchainLookup turn (an eth_call that reverted with OffchainLookup,
 * which viem is about to follow). Returns false once
 * MAX_OFFCHAIN_LOOKUPS_PER_REQUEST turns were taken in this request.
 */
export function takeOffchainLookup(): boolean {
  const budget = storage.getStore();
  if (!budget) return true;
  if (budget.offchainLookups >= MAX_OFFCHAIN_LOOKUPS_PER_REQUEST) return false;
  budget.offchainLookups++;
  return true;
}

/**
 * Take `bytes` of CCIP response from this request's allowance, as each chunk
 * arrives, so concurrent gateway reads can never overshoot it together.
 * Returns false (and takes nothing) when the allowance would be exceeded.
 * Outside a request there is no shared allowance; the per-response cap applies.
 */
export function takeCcipBytes(bytes: number): boolean {
  const budget = storage.getStore();
  if (!budget) return true;
  if (budget.ccipBytes + bytes > MAX_CCIP_BYTES_PER_REQUEST) {
    budget.ccipExhausted = true;
    return false;
  }
  budget.ccipBytes += bytes;
  return true;
}

/**
 * Take one gateway fetch (the first request or a redirect hop) from this
 * request's allowance before sending it.
 * Returns false once MAX_CCIP_REQUESTS_PER_REQUEST requests were sent, or once
 * the byte allowance has refused a read (every further response would be
 * refused at its first chunk).
 */
export function takeCcipRequest(): boolean {
  const budget = storage.getStore();
  if (!budget) return true;
  if (budget.ccipExhausted || budget.ccipRequests >= MAX_CCIP_REQUESTS_PER_REQUEST) {
    budget.ccipExhausted = true;
    return false;
  }
  budget.ccipRequests++;
  return true;
}
