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
import { AsyncLocalStorage } from 'node:async_hooks';

export const MAX_CCIP_BYTES_PER_REQUEST = 8 * 1024 * 1024;

interface RequestBudget {
  ccipBytes: number;
  ccipExhausted: boolean;
}

const storage = new AsyncLocalStorage<RequestBudget>();

/** Run `fn` with a fresh budget (called once per incoming request). */
export function withRequestBudget<T>(fn: () => T): T {
  return storage.run({ ccipBytes: 0, ccipExhausted: false }, fn);
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

/** True once this request's CCIP allowance has refused a read; no more gateway requests are worth sending. */
export function ccipAllowanceExhausted(): boolean {
  return storage.getStore()?.ccipExhausted ?? false;
}
