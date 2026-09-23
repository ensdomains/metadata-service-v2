// Shared error taxonomy for the resolution layer.
//
// The fallback chain (FallbackService) must distinguish "the name is genuinely
// absent from this source" from "this source failed/unreachable". Conflating the
// two is what let a single not-found trip the indexer circuit-breaker. With these
// types, absence falls through to the next tier WITHOUT marking the indexer
// unhealthy; only a real UpstreamError trips the breaker.

/** The requested name was not present in a data source (a clean miss, not a failure). */
export class NotFoundError extends Error {
  /**
   * True only when every tier, including the primary (v2) index, answered with
   * a clean miss. While the indexer circuit breaker is open the primary index is
   * skipped, so a miss from the remaining tiers is not proof of absence.
   */
  readonly definitive: boolean;

  constructor(message: string, options?: { definitive?: boolean }) {
    super(message);
    this.name = 'NotFoundError';
    this.definitive = options?.definitive ?? false;
  }
}

/** A data source (indexer/RPC) failed, timed out, or returned a transport/GraphQL error. */
export class UpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'UpstreamError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isNotFoundError(e: unknown): e is NotFoundError {
  return e instanceof NotFoundError;
}

export function isUpstreamError(e: unknown): e is UpstreamError {
  return e instanceof UpstreamError;
}
