// Outbound fetch for ENS media (avatar / header) URLs.
//
// The URL comes from an ENS record, i.e. from whoever owns the name. The
// @ensdomains/ens-avatar resolver checks the URL it resolves, but this service
// then fetches the bytes itself, and that request used to follow redirects to
// anywhere and was never checked at all when the record pointed at a JSON
// document whose `image` field named the real target. Every media fetch now goes
// through fetchMediaUrl, which checks every hop of the redirect chain:
//
//  - scheme must be http: or https:;
//  - the port must be the scheme's default (80 for http:, 443 for https:).
//    From compatibility date 2024-09-02 (allow_custom_ports) the Worker's
//    fetch() connects to whatever port the URL names, so otherwise a record,
//    a redirect or a gateway URL could aim it at any port of a public host;
//  - the host must not be a private/local target (the library's own
//    isPrivateHostname, applied after normalizing the hostname);
//  - the host must not be this service itself or a subdomain of it, so a record
//    cannot make the worker fetch its own endpoints recursively: its public
//    hostnames, its preview URLs, and whatever host the current request is
//    being served on (see withServingHost);
//  - redirects are followed manually, up to MAX_MEDIA_REDIRECTS.
//
// The ens-avatar resolvers' own requests (record JSON, NFT metadata, HEAD
// checks) go through createGuardedFetcher, and CCIP-read gateway requests go
// through guardedCcipRequest (ccip-request.ts), so every outbound request made
// on behalf of a name's records takes this path.
//
// Hostnames are normalized before comparison (lowercase, IPv6 brackets and any
// trailing dots removed): `metadata.ens.domains.` is the same host as
// `metadata.ens.domains`, and `localhost.` is still localhost. A hostname
// longer than DNS allows is refused before anything else looks at it: the URL
// parser accepts hosts of any length, and every one checked here is chosen by
// whoever controls a record, a redirect or an OffchainLookup revert.
import { AsyncLocalStorage } from 'node:async_hooks';
import { utils as avatarUtils, type Fetcher, type FetcherResponse } from '@ensdomains/ens-avatar';
import { UpstreamError } from './errors';
import { isOutageStatus, reportOutage } from './outage-scope';

/** This service's own public hostnames (see MetadataService's default origin and docs/webhook.md). */
export const SELF_HOSTNAMES: readonly string[] = [
  'metadata.ens.domains',
  'ens-metadata-v2.ensdomains.workers.dev',
];

// Cloudflare serves each version and alias of the worker on a preview URL,
// `<version or alias>-ens-metadata-v2.ensdomains.workers.dev`, which is not a
// subdomain of its workers.dev host.
export const SELF_PREVIEW_HOST_SUFFIX = '-ens-metadata-v2.ensdomains.workers.dev';

// The host the current request is being served on. The worker can be reached
// on hosts outside the ones above (another custom domain, a route), and every
// URL it builds for itself uses the request's own host; a record or gateway URL
// naming that host would make it fetch its own endpoints. Set per incoming
// request by withServingHost (a middleware in index.ts), and carried into the
// request's waitUntil work, like the request budget.
const servingHost = new AsyncLocalStorage<string>();

/** Run `fn` with `hostname` denied to the outbound fetches it makes. */
export function withServingHost<T>(hostname: string, fn: () => T): T {
  return servingHost.run(normalizeHostname(hostname), fn);
}

function isSelf(host: string): boolean {
  const serving = servingHost.getStore();
  return host.endsWith(SELF_PREVIEW_HOST_SUFFIX)
    || (!!serving && (host === serving || host.endsWith(`.${serving}`)));
}

// Same limit as the ens-avatar resolver, so any URL it accepts is also fetchable.
export const MAX_MEDIA_REDIRECTS = 10;

// RFC 1035: 253 characters, plus one optional trailing dot. Longer hosts cannot
// resolve.
const MAX_HOSTNAME_LENGTH = 254;

export class BlockedMediaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedMediaUrlError';
  }
}

export function normalizeHostname(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  // Strip trailing dots in one backward scan. The regex /\.+$/ retries from
  // every dot in a run and is quadratic on a long run of dots followed by a
  // letter.
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end--;
  return host.slice(0, end);
}

function isDenied(host: string, denyList: readonly string[]): boolean {
  return denyList.some((denied) => {
    const d = normalizeHostname(denied);
    return host === d || host.endsWith(`.${d}`);
  });
}

/**
 * Deny list in the form the ens-avatar resolver expects. The library compares
 * hostnames verbatim, so also list the trailing-dot spelling of each host.
 */
export function resolverDenyList(hosts: readonly string[] = SELF_HOSTNAMES): string[] {
  return hosts.flatMap((h) => [h, `${h}.`]);
}

/** Throw BlockedMediaUrlError unless `url` is an allowed outbound media target. */
export function assertFetchableMediaUrl(url: URL, denyList: readonly string[] = SELF_HOSTNAMES): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedMediaUrlError(`blocked media URL scheme: ${url.protocol}`);
  }
  // The URL parser drops a port equal to the scheme's default (`:443` on
  // https:, `:80` on http:), so any port still set is a non-default one.
  if (url.port !== '') {
    throw new BlockedMediaUrlError(`blocked media URL port: ${url.port}`);
  }
  if (url.hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new BlockedMediaUrlError(`blocked media host: longer than ${MAX_HOSTNAME_LENGTH} characters`);
  }
  const host = normalizeHostname(url.hostname);
  if (!host || avatarUtils.isPrivateHostname(host)) {
    throw new BlockedMediaUrlError(`blocked private media host: ${url.hostname}`);
  }
  if (isDenied(host, denyList) || isSelf(host)) {
    throw new BlockedMediaUrlError(`blocked media host: ${url.hostname}`);
  }
}

/**
 * GET a media URL, validating the initial URL and every redirect target.
 * Returns the first non-redirect response. Throws BlockedMediaUrlError for a
 * blocked hop or an over-long redirect chain. `beforeEachFetch`, when given,
 * runs before every request that is actually sent (each redirect hop is one)
 * and may throw to stop the chain.
 */
export interface MediaRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export async function fetchMediaUrl(
  url: string,
  init: MediaRequestInit = {},
  denyList: readonly string[] = SELF_HOSTNAMES,
  beforeEachFetch?: () => void,
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new BlockedMediaUrlError('invalid media URL');
  }

  let request: MediaRequestInit = init;
  for (let hop = 0; ; hop++) {
    assertFetchableMediaUrl(current, denyList);
    beforeEachFetch?.();
    const response = await fetch(current.toString(), { ...request, redirect: 'manual' });

    const isRedirect = response.status === 301
      || response.status === 302
      || response.status === 303
      || response.status === 307
      || response.status === 308;
    const location = isRedirect ? response.headers.get('Location') : null;
    if (!location) return response;

    // Release the redirect body before following it.
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_MEDIA_REDIRECTS) {
      throw new BlockedMediaUrlError(`too many media redirects (max ${MAX_MEDIA_REDIRECTS})`);
    }
    try {
      current = new URL(location, current);
    } catch {
      throw new BlockedMediaUrlError('invalid media redirect target');
    }
    // Fetch-spec redirect semantics: 303, and 301/302 after a POST, continue as
    // a GET without a body; 307/308 repeat the request as is.
    const method = (request.method ?? 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      const headers = { ...request.headers };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
      request = { ...request, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined, headers };
    }
  }
}

/**
 * Read a response body, but stop pulling from the stream as soon as more than
 * `maxBytes` have arrived, and return null in that case. Without this, a body
 * sent without Content-Length is buffered in full before any size check runs.
 * `take`, when given, is charged for every chunk and can also stop the read.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
  take?: (bytes: number) => boolean,
): Promise<ArrayBuffer | null> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes || (take && !take(value.byteLength))) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

// Read at most the first `bytes` bytes of a body and cancel the rest. Only
// those bytes are copied, and no chunk is kept, however large the chunks the
// body arrives in.
async function readBodyPrefix(response: Response, bytes: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const prefix = new Uint8Array(bytes);
  let filled = 0;
  try {
    while (filled < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, bytes - filled);
      prefix.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return prefix.buffer.slice(0, filled);
}

function concat(chunks: Uint8Array[], total: number): ArrayBuffer {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

// Report a failed request to the active lookup's outage scope
// (outage-scope.ts): the library catches the errors of its image check (HEAD,
// ranged GET) and reads them as "not an image". A blocked URL, an oversized
// body and a body that is not JSON are answers about the record, not outages.
async function reportingOutages<T>(request: () => Promise<FetcherResponse<T>>): Promise<FetcherResponse<T>> {
  try {
    const response = await request();
    if (isOutageStatus(response.status)) reportOutage(new UpstreamError(`media host answered ${response.status}`));
    return response;
  } catch (error) {
    if (!(error instanceof BlockedMediaUrlError) && !(error instanceof SyntaxError)) reportOutage(error);
    throw error;
  }
}

/**
 * A drop-in replacement for the ens-avatar resolver's fetcher. The library's
 * own fetcher checks only URL strings (its deny list compares hostnames
 * verbatim, so `host..` and `localhost.` pass), stops its timeout once headers
 * arrive, and reads JSON bodies with no size limit. This one sends every
 * request through fetchMediaUrl, applies one timeout to headers and body, and
 * caps every body it reads. Network errors, timeouts and failing statuses are
 * reported to the active lookup's outage scope, and a JSON request to a
 * failing host throws UpstreamError instead of parsing its error page.
 */
export function createGuardedFetcher(
  timeoutMs: number,
  maxBodyBytes: number,
  denyList: readonly string[] = SELF_HOSTNAMES,
): Fetcher {
  return {
    async get<T = unknown>(url: string, opts?: { headers?: Record<string, string> }): Promise<FetcherResponse<T>> {
      return reportingOutages(async () => {
        const response = await fetchMediaUrl(url, { method: 'GET', headers: opts?.headers, signal: AbortSignal.timeout(timeoutMs) }, denyList);
        if (isOutageStatus(response.status)) {
          await response.body?.cancel().catch(() => {});
          throw new UpstreamError(`metadata host answered ${response.status}`);
        }
        const body = await readBodyCapped(response, maxBodyBytes);
        if (!body) throw new BlockedMediaUrlError(`metadata response over ${maxBodyBytes} bytes`);
        const data = JSON.parse(new TextDecoder().decode(body)) as T;
        return { status: response.status, headers: headersToRecord(response.headers), data };
      });
    },
    async head(url: string): Promise<FetcherResponse<void>> {
      return reportingOutages(async () => {
        const response = await fetchMediaUrl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) }, denyList);
        await response.body?.cancel().catch(() => {});
        return { status: response.status, headers: headersToRecord(response.headers), data: undefined };
      });
    },
    async getArrayBuffer(
      url: string,
      opts?: { headers?: Record<string, string>; signal?: AbortSignal },
    ): Promise<FetcherResponse<ArrayBuffer>> {
      return reportingOutages(async () => {
        const response = await fetchMediaUrl(
          url,
          { method: 'GET', headers: opts?.headers, signal: opts?.signal ?? AbortSignal.timeout(timeoutMs) },
          denyList,
        );
        // The library only sniffs the first bytes of a body served as octet-stream.
        const data = await readBodyPrefix(response, 1024);
        return { status: response.status, headers: headersToRecord(response.headers), data };
      });
    },
  };
}
