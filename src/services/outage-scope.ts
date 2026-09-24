// Upstream failures that are swallowed before they reach AvatarService.
//
// The ens-avatar library reads several upstream failures as "no avatar": its
// image check answers false when the HEAD (or ranged GET) request fails, the
// 2.0.0-alpha.2 viem adapter maps every record-lookup error to null, and both
// that release and the hardened one read a failed tokenURI()/uri() call as
// "the token has no URI". So a null from the library does not prove that a
// name has no avatar. The requests made on behalf of one lookup (the guarded
// fetcher in media-fetch.ts and the client view in avatar.ts) report their
// failures to that lookup's scope, and AvatarService treats a null or an
// ambiguous library error as a failed lookup when its scope saw one. The scope
// is carried with AsyncLocalStorage, like the request budget
// (request-budget.ts), because the resolvers are shared by concurrent requests.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface OutageScope {
  /** The first failure reported while the scope was active. */
  outage?: unknown;
}

const storage = new AsyncLocalStorage<OutageScope>();

/** Run `fn` so that the failures reported while it runs land in `scope`. */
export function runInOutageScope<T>(scope: OutageScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Record an upstream failure for the active lookup (a no-op outside one). */
export function reportOutage(error: unknown): void {
  const scope = storage.getStore();
  if (scope && scope.outage === undefined) scope.outage = error;
}

/**
 * HTTP statuses that mean the host is failing or throttling rather than that
 * the resource is missing: 408, 429 and every 5xx except 501, which a host
 * that does not implement a method (e.g. HEAD) sends every time.
 */
export function isOutageStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501);
}
