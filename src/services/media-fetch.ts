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
//  - the host must not be a private/local target (the library's own
//    isPrivateHostname, applied after normalizing the hostname);
//  - the host must not be this service itself or a subdomain of it, so a record
//    cannot make the worker fetch its own endpoints recursively;
//  - redirects are followed manually, up to MAX_MEDIA_REDIRECTS.
//
// The ens-avatar resolvers' own requests (record JSON, NFT metadata, HEAD
// checks) go through createGuardedFetcher, and CCIP-read gateway requests go
// through guardedCcipRequest (ccip-request.ts), so every outbound request made
// on behalf of a name's records takes this path.
//
// Hostnames are normalized before comparison (lowercase, IPv6 brackets and any
// trailing dots removed): `metadata.ens.domains.` is the same host as
// `metadata.ens.domains`, and `localhost.` is still localhost.
import { utils as avatarUtils, type Fetcher, type FetcherResponse } from '@ensdomains/ens-avatar';

/** This service's own public hostnames (see MetadataService's default origin and docs/webhook.md). */
export const SELF_HOSTNAMES: readonly string[] = [
  'metadata.ens.domains',
  'ens-metadata-v2.ensdomains.workers.dev',
];

// Same limit as the ens-avatar resolver, so any URL it accepts is also fetchable.
export const MAX_MEDIA_REDIRECTS = 10;

export class BlockedMediaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedMediaUrlError';
  }
}

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
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
  const host = normalizeHostname(url.hostname);
  if (!host || avatarUtils.isPrivateHostname(host)) {
    throw new BlockedMediaUrlError(`blocked private media host: ${url.hostname}`);
  }
  if (isDenied(host, denyList)) {
    throw new BlockedMediaUrlError(`blocked media host: ${url.hostname}`);
  }
}

/**
 * GET a media URL, validating the initial URL and every redirect target.
 * Returns the first non-redirect response. Throws BlockedMediaUrlError for a
 * blocked hop or an over-long redirect chain.
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
    const response = await fetch(current.toString(), { ...request, redirect: 'manual' });

    const location = response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null;
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

// Read at most the first `bytes` bytes of a body and cancel the rest.
async function readBodyPrefix(response: Response, bytes: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concat(chunks, total).slice(0, bytes);
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

/**
 * A drop-in replacement for the ens-avatar resolver's fetcher. The library's
 * own fetcher checks only URL strings (its deny list compares hostnames
 * verbatim, so `host..` and `localhost.` pass), stops its timeout once headers
 * arrive, and reads JSON bodies with no size limit. This one sends every
 * request through fetchMediaUrl, applies one timeout to headers and body, and
 * caps every body it reads.
 */
export function createGuardedFetcher(
  timeoutMs: number,
  maxBodyBytes: number,
  denyList: readonly string[] = SELF_HOSTNAMES,
): Fetcher {
  return {
    async get<T = unknown>(url: string, opts?: { headers?: Record<string, string> }): Promise<FetcherResponse<T>> {
      const response = await fetchMediaUrl(url, { method: 'GET', headers: opts?.headers, signal: AbortSignal.timeout(timeoutMs) }, denyList);
      const body = await readBodyCapped(response, maxBodyBytes);
      if (!body) throw new BlockedMediaUrlError(`metadata response over ${maxBodyBytes} bytes`);
      const data = JSON.parse(new TextDecoder().decode(body)) as T;
      return { status: response.status, headers: headersToRecord(response.headers), data };
    },
    async head(url: string): Promise<FetcherResponse<void>> {
      const response = await fetchMediaUrl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) }, denyList);
      await response.body?.cancel().catch(() => {});
      return { status: response.status, headers: headersToRecord(response.headers), data: undefined };
    },
    async getArrayBuffer(
      url: string,
      opts?: { headers?: Record<string, string>; signal?: AbortSignal },
    ): Promise<FetcherResponse<ArrayBuffer>> {
      const response = await fetchMediaUrl(
        url,
        { method: 'GET', headers: opts?.headers, signal: opts?.signal ?? AbortSignal.timeout(timeoutMs) },
        denyList,
      );
      // The library only sniffs the first bytes of a body served as octet-stream.
      const data = await readBodyPrefix(response, 1024);
      return { status: response.status, headers: headersToRecord(response.headers), data };
    },
  };
}
