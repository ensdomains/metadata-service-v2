import { AvatarResolver, utils as avatarUtils } from '@ensdomains/ens-avatar';
import { fromViem, type ViemClientLike } from '@ensdomains/ens-avatar/viem';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  createPublicClient,
  isAddress,
  type Chain,
  type PublicClient,
} from 'viem';
import { BlockedMediaUrlError, createGuardedFetcher, fetchMediaUrl, readBodyCapped, resolverDenyList } from './media-fetch';
import { ccipBudgetedHttp, guardedCcipRequest } from './ccip-request';
import { UpstreamError } from './errors';
import { isOutageStatus, reportOutage, runInOutageScope, type OutageScope } from './outage-scope';
import { normalize } from '../utils/ens';
import { toSafeImage } from './media-safety';

export interface AvatarImage {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Avatar-record metadata — the `/{network}/avatar/{name}/meta` response. This is
 * the parsed NFT/URI metadata behind an ENS `avatar` record (NOT the ENS-NFT
 * metadata), mirroring the v1 service's AvatarMetadata shape. `host_meta` and
 * `is_owner` are present only for NFT avatars (eip155 records); they're populated
 * by @ensdomains/ens-avatar's erc721/erc1155 specs. Extra token/URI-metadata
 * fields are passed through verbatim via the index signature.
 */
export interface AvatarMetadata {
  uri: string;
  image?: string;
  image_url?: string;
  image_data?: string;
  name?: string;
  description?: string;
  attributes?: unknown[];
  host_meta?: {
    chain_id?: number;
    namespace?: string;
    contract_address?: string;
    token_id?: string;
    reference_url?: string;
  };
  is_owner?: boolean;
  [key: string]: unknown;
}

// Hard cap on ENS media resolution (RPC + any NFT-metadata/CCIP fetch). Keeps a
// slow RPC from stalling an image request until the 30s global timeout.
const MEDIA_RESOLVE_TIMEOUT_MS = 8_000;


// Cap on a JSON document the resolver fetches (an avatar record's URI metadata,
// NFT token metadata). JSON.parse turns a document into many times its size in
// heap, so this is far below the image cap; real metadata is kilobytes.
const MAX_METADATA_JSON_BYTES = 2 * 1024 * 1024;

// Default max media image size (overridable via the MAX_AVATAR_BYTES env var).
// A user-controlled URL is fetched and (for avatars) base64-embedded into the
// generated SVG, so cap it to bound memory/output (DoS guard). NB: base64 inflates
// by ~33%, and the rendered SVG is cached in KV (25 MB value limit) — so an avatar
// above ~18 MB renders but its SVG won't fit in KV and just won't be cached.
const DEFAULT_MAX_AVATAR_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Rewrite decentralized-storage URIs (ipfs://, ar://) to public HTTPS gateways so
 * the metadata's `image` is directly fetchable by consumers — the v1 service did
 * the same for IPFS. http(s)/data URIs pass through untouched.
 */
function toGatewayUrl(uri: string): string {
  if (uri.startsWith('ipfs://ipfs/')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://ipfs/'.length)}`;
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice('ar://'.length)}`;
  return uri;
}

// Universal Resolver errors that mean "the name has no such record", read the
// way the hardened ens-avatar viem adapter reads a strict text lookup: a
// gateway's HttpError counts only for 404/410, and any other error (an RPC
// failure, a gateway outage) means the lookup failed.
const NO_RECORD_ERRORS = new Set([
  'ResolverNotFound',
  'ResolverNotContract',
  'ResolverError',
  'UnsupportedResolverProfile',
  'ReverseAddressMismatch',
]);
const NO_RECORD_GATEWAY_STATUSES = new Set([404, 410]);

function isNoRecordError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  const decoded = revert instanceof ContractFunctionRevertedError ? revert.data : undefined;
  if (!decoded) return false;
  if (NO_RECORD_ERRORS.has(decoded.errorName)) return true;
  return decoded.errorName === 'HttpError' && NO_RECORD_GATEWAY_STATUSES.has(Number(decoded.args?.[0]));
}

// A contract read that failed on the way to the contract (RPC endpoint, CCIP
// gateway) rather than being answered by it with a revert or no data. A
// gateway that answers 404 has answered too.
function isContractReadOutage(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const answered = error.walk(
    (e) =>
      e instanceof ContractFunctionRevertedError ||
      e instanceof ContractFunctionZeroDataError ||
      e instanceof ExecutionRevertedError,
  );
  if (answered) return false;
  const failed = error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError);
  if (failed instanceof HttpRequestError && failed.status !== undefined) return isOutageStatus(failed.status);
  return !!failed;
}

/**
 * The viem client as ens-avatar sees it. The text record is read in strict
 * mode, and every error that does not mean "no record" is reported to the
 * active lookup's outage scope (outage-scope.ts) and rethrown, as the hardened
 * ens-avatar adapter throws it; the alpha.2 adapter still turns it into null,
 * but the lookup is then known to have failed. A tokenURI()/uri() read that
 * failed before reaching the contract is reported too: both library releases
 * read it as "the token has no URI". The address lookup only feeds the
 * ownership check, so its errors are left to the library.
 */
function observeLookups(client: PublicClient): ViemClientLike {
  return {
    chain: client.chain,
    getEnsAddress: (args) => client.getEnsAddress(args as Parameters<PublicClient['getEnsAddress']>[0]),
    async getEnsText(args) {
      try {
        return await client.getEnsText({ ...args, strict: true } as Parameters<PublicClient['getEnsText']>[0]);
      } catch (error) {
        if (isNoRecordError(error)) return null;
        reportOutage(error);
        throw error;
      }
    },
    async readContract(args) {
      try {
        return await client.readContract(args as Parameters<PublicClient['readContract']>[0]);
      } catch (error) {
        if ((args.functionName === 'tokenURI' || args.functionName === 'uri') && isContractReadOutage(error)) {
          reportOutage(error);
        }
        throw error;
      }
    },
  } as ViemClientLike;
}

// ens-avatar's error for metadata with no image field.
const IMAGE_NOT_AVAILABLE = 'Image is not available';

/**
 * True when an error from an ens-avatar lookup means that the name has no
 * usable avatar, false when the lookup failed and the record may well exist.
 *
 * - A miss whatever else happened: a URL the guard refuses (or a metadata body
 *   over the cap), the library's own record errors (ChainMismatch,
 *   MetadataParsingError, NFTURIParsingError, UnsupportedNamespace: subclasses
 *   of its BaseError) and "Image is not available" (a bare string in alpha.2, a
 *   BaseError in the hardened release).
 * - A failure: our timeout and a failing host's status (UpstreamError), and
 *   viem's RPC and gateway errors, which the hardened release throws from the
 *   record lookup.
 * - Anything else (a plain library BaseError such as "tokenURI is empty or
 *   could not be retrieved", a body that is not JSON, a TypeError on malformed
 *   metadata) is also what a swallowed failure turns into, so it is a miss only
 *   when no request of the lookup failed. Every request a lookup makes either
 *   reports its failure to the lookup's outage scope (the guarded fetcher and
 *   observeLookups) or fails with a viem error, so a record that can never
 *   resolve is not retried forever as an outage.
 */
function isDefinitiveMiss(error: unknown, outageSeen: boolean): boolean {
  if (error instanceof BlockedMediaUrlError || error === IMAGE_NOT_AVAILABLE) return true;
  if (
    error instanceof avatarUtils.BaseError &&
    (Object.getPrototypeOf(error) !== avatarUtils.BaseError.prototype || error.message === IMAGE_NOT_AVAILABLE)
  ) {
    return true;
  }
  if (error instanceof UpstreamError || error instanceof BaseError) return false;
  return !outageSeen;
}

export class AvatarService {
  private resolver: AvatarResolver;
  // Fallback resolver using the chain's default (legacy) universal resolver, set
  // only when `resolver` was pointed at a v2 universal resolver (see constructor).
  private legacyResolver?: AvatarResolver;
  private maxAvatarBytes: number;

  constructor(
    rpcUrl: string,
    chain: Chain,
    maxAvatarBytes: number = DEFAULT_MAX_AVATAR_BYTES,
    universalResolver?: string,
  ) {
    this.maxAvatarBytes = maxAvatarBytes;
    // ens-avatar 2.x takes a ChainClient (ethers-free core). We adapt a viem
    // PublicClient via `fromViem` — viem is already this project's chain library
    // and one of ens-avatar's optional peers, so no extra dependency (the old
    // ethers path is gone). CCIP-read / wildcard resolution is handled by viem.
    // Tight transport budget: ENS avatar resolution makes several RPC calls, so
    // viem's default 10s × 3 retries can blow past the request timeout. Fail fast
    // (the image still renders without the avatar).
    const client = createPublicClient({
      chain,
      transport: ccipBudgetedHttp(rpcUrl, { timeout: 6_000, retryCount: 1 }),
      // CCIP-read gateway URLs come from contracts anyone can deploy, and the
      // transport bounds how many lookups they can chain (ccip-request.ts).
      ccipRead: { request: guardedCcipRequest },
    });
    // The library reads records and token URIs through this view of the client,
    // which reports the failures it would otherwise take for "no avatar".
    const lookupClient = observeLookups(client);

    // Native-v2 names live in the v2 registry, which viem's stock universal
    // resolver doesn't traverse — so their avatar/header records resolve to null.
    // When a v2 universal resolver is configured (e.g. Sepolia), route record
    // lookups through it. `{ strict: false }` accepts lowercase config addresses;
    // an unset/placeholder value falls back to viem's default resolver.
    const v2UR = isAddress(universalResolver ?? '', { strict: false }) ? universalResolver : undefined;
    // Never let a record resolve to this service itself (anti-recursion). The
    // library's own fetcher is replaced so its record/metadata/HEAD requests go
    // through the same guard, timeout and size cap as the media fetch; the
    // options still feed the library's URL-level deny checks. The library timer
    // matches the 8s media budget, so it never cuts a request that would finish
    // inside it.
    const resolverOptions = { urlDenyList: resolverDenyList(), timeout: MEDIA_RESOLVE_TIMEOUT_MS };
    const guardedFetcher = createGuardedFetcher(MEDIA_RESOLVE_TIMEOUT_MS, MAX_METADATA_JSON_BYTES);
    this.resolver = new AvatarResolver(
      fromViem(lookupClient, v2UR ? { universalResolverAddress: v2UR } : undefined),
      resolverOptions,
    );
    this.resolver.fetcher = guardedFetcher;
    // With a v2 resolver in front, keep a default-resolver fallback for v1/migrated
    // names the v2 resolver doesn't return. (No fallback when there's no override —
    // the primary already IS the default resolver.)
    this.legacyResolver = v2UR ? new AvatarResolver(fromViem(lookupClient), resolverOptions) : undefined;
    if (this.legacyResolver) this.legacyResolver.fetcher = guardedFetcher;
  }

  /**
   * Get avatar image for an ENS name using @ensdomains/ens-avatar.
   * Supports NFT avatars, IPFS, HTTP/HTTPS, and data URIs.
   *
   * @returns the image, or null when the name has no usable avatar.
   * @throws UpstreamError when the lookup failed (RPC, CCIP gateway or media
   *         host error, timeout): the name may have an avatar we could not get.
   */
  async getAvatarImage(name: string): Promise<AvatarImage | null> {
    return this.resolveMedia('avatar', name);
  }

  /**
   * Get header/banner image for an ENS name (the `header` text record).
   * Same resolution + fetch contract as the avatar.
   */
  async getHeaderImage(name: string): Promise<AvatarImage | null> {
    return this.resolveMedia('header', name);
  }

  /**
   * Resolve an ENS name's `avatar` record to its metadata object — the v1-parity
   * `/{network}/avatar/{name}/meta` response. For NFT avatars this includes
   * `host_meta` (chain/contract/token) and `is_owner`; for URI avatars it's the
   * fetched token/URI metadata. Mirrors the image path's resolution discipline:
   * the (possibly v2) primary resolver first, a legacy-resolver fallback for
   * v1/migrated names, a hard timeout, and the same miss/failure split.
   *
   * @param name           the ENS name.
   * @param avatarImageUrl absolute URL of THIS deployment's avatar *image* endpoint
   *                       for `name`. Used as the `image` value when the record
   *                       only carries inline `image_data` (v1 behavior) — the
   *                       image endpoint materializes and sanitizes those bytes.
   * @returns the metadata, or null when there's no resolvable avatar with a usable
   *          image (the route maps null → 404 "No results found.").
   * @throws UpstreamError when the lookup failed (the route maps it to 503).
   */
  async getAvatarMeta(name: string, avatarImageUrl?: string): Promise<AvatarMetadata | null> {
    // A non-normalizable name can't have a resolvable record (same gate as media).
    let normalized: string;
    try {
      normalized = normalize(name);
    } catch {
      return null;
    }

    const metadata = await this.withLegacyFallback((resolver) =>
      this.resolveMetadataRecord(resolver, normalized, name),
    );
    if (!metadata) {
      return null;
    }

    // Resolve a usable, absolute `image` (v1 parity): explicit image → image_url →
    // (for inline on-chain images) this service's avatar image endpoint. A record
    // with no image at all is treated as "no results", matching v1's 404.
    const rawImage =
      (typeof metadata.image === 'string' && metadata.image) ||
      (typeof metadata.image_url === 'string' && metadata.image_url) ||
      (typeof metadata.image_data === 'string' ? avatarImageUrl : undefined) ||
      undefined;
    if (!rawImage) {
      return null;
    }

    metadata.image = toGatewayUrl(rawImage);
    // Echo the requested name if the library didn't set `uri`.
    if (typeof metadata.uri !== 'string') {
      metadata.uri = name;
    }
    return metadata;
  }

  /**
   * Resolve an ENS media record (avatar or header) to image bytes. Resolves the
   * record URI via ens-avatar, then materializes it (data URI or HTTP fetch).
   * Returns null when the name has no usable record; throws UpstreamError when
   * the lookup or the fetch failed, so callers do not cache the absence.
   */
  private async resolveMedia(kind: 'avatar' | 'header', name: string): Promise<AvatarImage | null> {
    // viem's ENS resolution requires ENSIP-15-normalized names (the fromViem
    // adapter passes the name through as-is). A non-normalizable name can't have
    // a resolvable record → treat as none.
    let normalized: string;
    try {
      normalized = normalize(name);
    } catch {
      return null;
    }

    const uri = await this.withLegacyFallback((resolver) => this.resolveRecord(resolver, kind, normalized, name));
    if (!uri) {
      return null;
    }

    try {
      return await this.fetchMedia(uri, kind, name);
    } catch (error) {
      // A blocked URL or redirect hop is a problem with the record; a network
      // error or timeout means the image may be there.
      if (error instanceof BlockedMediaUrlError) {
        console.warn(`Blocked ${kind} URL for ${name}:`, error);
        return null;
      }
      console.warn(`Error fetching ${kind} for ${name}:`, error);
      throw error instanceof UpstreamError ? error : new UpstreamError(`${kind} fetch failed for ${name}`, { cause: error });
    }
  }

  /**
   * Look a record up through the primary resolver and, when it has nothing,
   * through the legacy resolver (v1/migrated names). A failed primary lookup is
   * overridden only by a legacy hit: a legacy null does not show that the name
   * has no record (a native-v2 name's record is behind the primary), so the
   * failure stands.
   */
  private async withLegacyFallback<T>(lookup: (resolver: AvatarResolver) => Promise<T | null>): Promise<T | null> {
    if (!this.legacyResolver) return lookup(this.resolver);
    let primaryFailure: unknown;
    try {
      const found = await lookup(this.resolver);
      if (found) return found;
    } catch (error) {
      primaryFailure = error;
    }
    const legacy = await lookup(this.legacyResolver);
    if (legacy || primaryFailure === undefined) return legacy;
    throw primaryFailure;
  }

  /**
   * Resolve a single media record via one resolver, bounded by a hard timeout so a
   * slow RPC/gateway fails fast instead of stalling until the global request
   * timeout. Returns null for a definitive miss and throws UpstreamError when the
   * lookup failed (see lookup).
   */
  private async resolveRecord(
    resolver: AvatarResolver,
    kind: 'avatar' | 'header',
    normalized: string,
    name: string,
  ): Promise<string | null> {
    return this.lookup(
      () => (kind === 'avatar' ? resolver.getAvatar(normalized, {}) : resolver.getHeader(normalized, {})),
      `${kind} resolution`,
      name,
    );
  }

  /**
   * Run one ens-avatar lookup under the media timeout, in its own outage scope
   * (outage-scope.ts), and sort the outcome: the value; null when the name has
   * no usable record; or UpstreamError when the lookup failed, i.e. it timed out,
   * threw anything but a definitive miss (isDefinitiveMiss), or came back empty
   * after a request it made had failed.
   */
  private async lookup<T>(work: () => Promise<T | null>, what: string, name: string): Promise<T | null> {
    const scope: OutageScope = {};
    let result: T | null;
    try {
      result = await runInOutageScope(scope, () => this.withMediaTimeout(work(), `${what} timed out for ${name}`));
    } catch (error) {
      if (isDefinitiveMiss(error, scope.outage !== undefined)) {
        console.warn(`${what} found no usable record for ${name}:`, error);
        return null;
      }
      console.warn(`${what} failed for ${name}:`, error);
      throw error instanceof UpstreamError ? error : new UpstreamError(`${what} failed for ${name}`, { cause: error });
    }
    if (!result && scope.outage !== undefined) {
      console.warn(`${what} failed for ${name}:`, scope.outage);
      throw new UpstreamError(`${what} failed for ${name}`, { cause: scope.outage });
    }
    return result;
  }

  /**
   * Race a media-resolution promise against the hard timeout (MEDIA_RESOLVE_TIMEOUT_MS)
   * so a slow RPC/gateway fails fast instead of stalling until the global
   * request timeout. Rejects with UpstreamError(`timeoutMessage`) on expiry.
   */
  private withMediaTimeout<T>(work: Promise<T>, timeoutMessage: string): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new UpstreamError(timeoutMessage)), MEDIA_RESOLVE_TIMEOUT_MS),
      ),
    ]);
  }

  /**
   * Resolve avatar-record metadata via one resolver, bounded by the media timeout.
   * Returns null for a definitive miss and throws UpstreamError when the lookup
   * failed (see lookup).
   */
  private async resolveMetadataRecord(
    resolver: AvatarResolver,
    normalized: string,
    name: string,
  ): Promise<AvatarMetadata | null> {
    return this.lookup(
      () => resolver.getMetadata(normalized) as Promise<AvatarMetadata | null>,
      'avatar metadata resolution',
      name,
    );
  }

  /**
   * Materialize a resolved media URI (data: or http(s)) into image bytes.
   *
   * The bytes are chosen by the name's owner and are served on this origin and
   * embedded in the NFT card, so the declared type (data: URI prefix or remote
   * Content-Type) is never used: toSafeImage derives the type from the bytes
   * themselves, accepts SVG only with an <svg> root (served unchanged under
   * MEDIA_SECURITY_HEADERS), and rejects anything outside the image allowlist.
   */
  private async fetchMedia(uri: string, kind: string, name: string): Promise<AvatarImage | null> {
    // Handle data URIs (already base64 encoded)
    if (uri.startsWith('data:')) {
      const base64data = uri.split('base64,')[1];

      if (!base64data) {
        console.warn(`Invalid data URI format for ${kind} of ${name}`);
        return null;
      }

      const safe = toSafeImage(Buffer.from(base64data, 'base64'));
      if (!safe) {
        console.warn(`Rejected ${kind} data URI for ${name}: not an allowlisted image`);
      }
      return safe;
    }

    // Handle HTTP/HTTPS URLs (ens-avatar resolves IPFS and NFTs to HTTP URLs)
    if (uri.startsWith('http')) {
      // Validates the URL and every redirect hop (scheme, private hosts, this
      // service's own hostnames); a blocked URL throws and degrades to "none".
      const response = await fetchMediaUrl(uri, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'user-agent': 'ENS-Metadata-V2/1.0.0',
        },
      });

      if (!response.ok) {
        console.warn(`Failed to fetch ${kind} for ${name}: ${response.status}`);
        // A failing or throttling host (5xx, 429) may serve the image later;
        // any other status (404, 410, 403, ...) is the record's problem.
        if (isOutageStatus(response.status)) {
          throw new UpstreamError(`${kind} host answered ${response.status} for ${name}`);
        }
        return null;
      }

      // Cap the size: a user-controlled URL could serve an arbitrarily large body
      // (memory/DoS, and an avatar gets base64-embedded into the SVG). Reject early
      // on a declared oversize, then bound the actual bytes.
      const declared = Number(response.headers.get('Content-Length') ?? '');
      if (Number.isFinite(declared) && declared > this.maxAvatarBytes) {
        console.warn(`${kind} for ${name} too large (Content-Length ${declared})`);
        return null;
      }

      const arrayBuffer = await readBodyCapped(response, this.maxAvatarBytes);
      if (!arrayBuffer) {
        console.warn(`${kind} for ${name} too large (over ${this.maxAvatarBytes} bytes)`);
        return null;
      }
      const safe = toSafeImage(Buffer.from(arrayBuffer));
      if (!safe) {
        console.warn(`Rejected ${kind} for ${name}: not an allowlisted image`);
      }
      return safe;
    }

    console.warn(`Unsupported ${kind} URI format for ${name}: ${uri}`);
    return null;
  }

  /**
   * Get avatar as base64 string for embedding in SVG
   */
  async getAvatarBase64(name: string): Promise<{ base64: string; mimeType: string } | null> {
    const avatar = await this.getAvatarImage(name);

    if (!avatar) {
      return null;
    }

    return {
      base64: avatar.buffer.toString('base64'),
      mimeType: avatar.mimeType,
    };
  }
}
