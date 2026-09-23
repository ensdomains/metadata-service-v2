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
//  - gateway requests, since one batch sends as many as it has queries;
//  - OffchainLookup turns. viem follows OffchainLookup recursively with no
//    depth limit: when the callback reverts with another OffchainLookup it
//    calls the gateway (or the local batch gateway, which with no queries sends
//    nothing) and then the contract again. A contract can keep one lookup
//    looping on tiny or no gateway responses, one RPC eth_call per turn, until
//    the Worker hits its subrequest limit.
import { AsyncLocalStorage } from 'node:async_hooks';

export const MAX_CCIP_BYTES_PER_REQUEST = 8 * 1024 * 1024;
// A real lookup takes one or two turns and one gateway request per turn, and a
// request reads a handful of records.
export const MAX_CCIP_REQUESTS_PER_REQUEST = 32;
export const MAX_OFFCHAIN_LOOKUPS_PER_REQUEST = 32;

interface RequestBudget {
  ccipBytes: number;
  ccipRequests: number;
  ccipExhausted: boolean;
  offchainLookups: number;
}

const storage = new AsyncLocalStorage<RequestBudget>();

/** Run `fn` with a fresh budget (called once per incoming request). */
export function withRequestBudget<T>(fn: () => T): T {
  return storage.run({ ccipBytes: 0, ccipRequests: 0, ccipExhausted: false, offchainLookups: 0 }, fn);
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
 * Take one gateway request from this request's allowance before sending it.
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
