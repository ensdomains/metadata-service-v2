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
// Hostnames are normalized before comparison (lowercase, IPv6 brackets and any
// trailing dots removed): `metadata.ens.domains.` is the same host as
// `metadata.ens.domains`, and `localhost.` is still localhost.
import { utils as avatarUtils } from '@ensdomains/ens-avatar';

/** This service's own public hostnames (see MetadataService's default origin and docs/webhook.md). */
export const SELF_HOSTNAMES: readonly string[] = [
  'metadata.ens.domains',
  'ens-metadata-v2.ensdomains.workers.dev',
];

export const MAX_MEDIA_REDIRECTS = 5;

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
export async function fetchMediaUrl(
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  denyList: readonly string[] = SELF_HOSTNAMES,
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new BlockedMediaUrlError('invalid media URL');
  }

  for (let hop = 0; ; hop++) {
    assertFetchableMediaUrl(current, denyList);
    const response = await fetch(current.toString(), { ...init, redirect: 'manual' });

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
  }
}

/**
 * Read a response body, but stop pulling from the stream as soon as more than
 * `maxBytes` have arrived. Without this, a body sent without Content-Length is
 * buffered in full before any size check can run. The returned buffer is then
 * larger than `maxBytes`, so callers keep a single `byteLength > max` check.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
