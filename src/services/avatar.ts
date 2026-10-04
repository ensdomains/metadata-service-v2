import { AvatarResolver, utils as avatarUtils, type ChainClient, type AvatarResolverOpts, type Fetcher } from '@ensdomains/ens-avatar';
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
  isHex,
  type Chain,
  type PublicClient,
} from 'viem';
import { BlockedMediaUrlError, createGuardedFetcher, fetchMediaUrl, readBodyCapped, resolverDenyList } from './media-fetch';
import { CcipGatewayError, ccipBudgetedHttp, guardedCcipRequest, isFinalGatewayStatus } from './ccip-request';
import { UpstreamError } from './errors';
import { isOutageStatus, reportOutage, runInOutageScope, type OutageScope } from './outage-scope';
import { normalize } from '../utils/ens';
import { raceRequestDeadline, timeLeftForAttempt } from './request-budget';
import { toSafeImage } from './media-safety';
import { DEFAULT_IPFS_GATEWAY, toLiveGatewayUrl } from './ipfs-gateway';

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
 * fields are passed through via the index signature, apart from the scrub of
 * whole-string script and data: URLs and the depth limit; image and link fields
 * are sanitized first and `image_data` is never served (see sanitizeAvatarMeta).
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
 * Rewrite decentralized-storage URIs (ipfs://, ipns://, ar://) to HTTPS gateways
 * so the metadata's media links are directly fetchable by consumers — the v1
 * service did the same for IPFS — and links on a retired public IPFS gateway to
 * `ipfsGateway` (see ipfs-gateway.ts). Other http(s) and data URIs pass through
 * untouched.
 */
function toGatewayUrl(uri: string, ipfsGateway: string): string {
  if (uri.startsWith('ipfs://ipfs/')) return `${ipfsGateway}/ipfs/${uri.slice('ipfs://ipfs/'.length)}`;
  if (uri.startsWith('ipfs://')) return `${ipfsGateway}/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('ipns://')) return `${ipfsGateway}/ipns/${uri.slice('ipns://'.length)}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice('ar://'.length)}`;
  return toLiveGatewayUrl(uri, ipfsGateway);
}

// Universal Resolver errors that mean "the name has no such record". A
// gateway's HttpError counts too when its status is the gateway's final answer
// (isFinalGatewayStatus: a 4xx other than 401, 403, 408 and 429, as EIP-3668
// makes a 4xx final), and a gateway URL the guard refuses is reported as one
// (ccip-request.ts). Any other error (an RPC failure, a gateway failure or any
// other gateway status) means the lookup failed. The hardened ens-avatar viem
// adapter counts only 404/410, but it never sees these errors: observeLookups
// answers null for them first.
const NO_RECORD_ERRORS = new Set([
  'ResolverNotFound',
  'ResolverNotContract',
  'ResolverError',
  'UnsupportedResolverProfile',
  'ReverseAddressMismatch',
]);

function isNoRecordError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  const decoded = revert instanceof ContractFunctionRevertedError ? revert.data : undefined;
  if (!decoded) return false;
  if (NO_RECORD_ERRORS.has(decoded.errorName)) return true;
  return decoded.errorName === 'HttpError' && isFinalGatewayStatus(Number(decoded.args?.[0]));
}

// A contract read that failed on the way to the contract (RPC endpoint, CCIP
// gateway) rather than being answered by it with a revert or no data. A
// gateway whose status is its final answer (isFinalGatewayStatus) has answered
// too; any HTTP error of the RPC endpoint (a 401 or 403 included) is a failure.
function isContractReadOutage(error: unknown): boolean {
  // Not viem's own error: viem crashed on an RPC answer it could not read (a
  // -32603 whose data is null makes its revert decoding throw a TypeError).
  if (!(error instanceof BaseError)) return true;
  // viem types a JSON-RPC -32603 "Internal error" as a revert (and drops the
  // RPC error from the chain) whose data is the RPC error's data: none, "0x" or
  // a string that is not hex. A node reports a revert without data as
  // "execution reverted".
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (
    revert instanceof ContractFunctionRevertedError &&
    (revert.raw === undefined || revert.raw === '0x' || !isHex(revert.raw)) &&
    !ExecutionRevertedError.nodeMessage.test((revert.reason ?? '').toLowerCase())
  ) {
    return true;
  }
  const answered = error.walk(
    (e) =>
      e instanceof ContractFunctionRevertedError ||
      e instanceof ContractFunctionZeroDataError ||
      e instanceof ExecutionRevertedError,
  );
  if (answered) return false;
  const failed = error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError);
  if (failed instanceof CcipGatewayError && failed.status !== undefined) return !isFinalGatewayStatus(failed.status);
  if (failed) return true;
  // The same crash wrapped by viem (e.g. a -32603 whose data is a number).
  return !!error.walk((e) => !(e instanceof BaseError));
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

// An avatar record that names an NFT (CAIP-22/29, optionally as a did:nft: DID).
// Only for these does ens-avatar compute `host_meta` and `is_owner` itself.
const NFT_RECORD = /^(?:did:nft:)?eip155:/i;

// Link fields of token/URI metadata that consumers follow or embed (ERC-721 /
// OpenSea metadata, plus OpenSea's older `external_link` that v1 responses
// carried, and the extra media URLs and permalink of OpenSea API responses,
// which ERC-1155 token URIs may point at). `image` and `image_url` are
// handled separately.
const LINK_FIELDS = [
  'animation_url',
  'external_url',
  'external_link',
  'youtube_url',
  'animation_original_url',
  'image_preview_url',
  'image_thumbnail_url',
  'image_original_url',
  'permalink',
] as const;

// Nesting past which metadata is not echoed (real token metadata nests two or
// three levels: attributes, properties).
const MAX_META_DEPTH = 16;

/**
 * True for a value a consumer may put in a link or embed that runs script
 * (javascript:, vbscript:) or carries inline content (a data: URL, which has a
 * comma), which this service never echoes. Like the URL parser, it skips
 * leading spaces and control characters and ignores tabs and newlines
 * anywhere, so "java\tscript:" is javascript:. It also skips leading Unicode
 * whitespace (NBSP, BOM, U+3000, ...), which a consumer may trim before use.
 */
function isScriptOrInlineUrl(value: string): boolean {
  const url = value.replace(/[\t\n\r]/g, '');
  let start = 0;
  // Also U+0085 (NEL), which \s misses but Python's strip() and Go's TrimSpace remove.
  while (start < url.length && (url.charCodeAt(start) <= 0x20 || url.charCodeAt(start) === 0x85 || /\s/.test(url[start]))) start++;
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url.slice(start))?.[0].toLowerCase();
  return scheme === 'javascript:' || scheme === 'vbscript:' || (scheme === 'data:' && url.includes(',', start));
}

/**
 * `value` without the strings that isScriptOrInlineUrl rejects, at any depth
 * (dropped from objects, filtered out of arrays), without anything nested
 * deeper than MAX_META_DEPTH, and without `__proto__` keys (which a consumer's
 * naive deep merge would take for the prototype). undefined when `value`
 * itself is dropped.
 */
function scrubMetaValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return isScriptOrInlineUrl(value) ? undefined : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_META_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => scrubMetaValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const clean = scrubMetaValue(item, depth + 1);
    if (clean !== undefined && key !== '__proto__') out[key] = clean;
  }
  return out;
}

// Longest value handed to ens-avatar's resolveURI in resolveStoragePath. Real
// CIDs are under 100 characters; alpha.2 runs CID.parse, which is quadratic in
// the input length, on the uncapped value (the hardened release caps CIDs at 256).
const MAX_STORAGE_PATH_LENGTH = 512;

/**
 * The storage forms the library's image resolution also accepts — a bare CID,
 * `ipfs/<cid>/…`, `/ipfs/<cid>/…`, `ipns/<name>` — as the gateway URL the avatar
 * endpoint resolves them to (ens-avatar's resolveURI, with the IPFS gateway the
 * service's resolvers use). Only its gateway rewrites count (isOnChain false):
 * its fallback strips a data: prefix, turning e.g. `data:,https://…` into a URL.
 */
function resolveStoragePath(value: string, ipfsGateway: string): string | null {
  if (value.length > MAX_STORAGE_PATH_LENGTH) return null;
  try {
    const { uri, isOnChain } = avatarUtils.resolveURI(value, { ipfs: ipfsGateway });
    return isOnChain ? null : uri;
  } catch {
    return null;
  }
}

function parseHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/**
 * `value` as a canonical http(s) URL (ipfs/ipns/ar URIs and CID paths rewritten
 * to gateways first), else null.
 */
function toHttpUrl(value: unknown, ipfsGateway: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return parseHttpUrl(toGatewayUrl(trimmed, ipfsGateway)) ?? parseHttpUrl(resolveStoragePath(trimmed, ipfsGateway));
}

/**
 * The image the avatar endpoint serves for `metadata`: ens-avatar's own image
 * resolution (getImageURI, which AvatarResolver.getAvatar returns), with the
 * resolver's options. It takes the first non-empty string of image → image_url
 * → image_data and gives a data: URI for an inline image (an SVG sanitized by
 * the library, or a raster image whose bytes match its type), an http(s) URL,
 * or null when it serves nothing. (For a remote URL getAvatar also checks that
 * it is an image; /meta leaves that to the consumer who fetches it.)
 */
function servedImage(metadata: AvatarMetadata, options: AvatarResolverOpts | undefined): string | null {
  try {
    return avatarUtils.getImageURI({
      metadata,
      gateways: { ipfs: options?.ipfs, arweave: options?.arweave },
      urlDenyList: options?.urlDenyList,
      maxSvgLength: options?.maxSvgLength,
      maxContentLength: options?.maxContentLength,
    });
  } catch {
    return null;
  }
}

/**
 * Make getMetadata output safe to serve as the /meta response. ens-avatar returns
 * metadata as published — raw values chosen by the record or token owner — and
 * consumers render these fields, so:
 * - `image` is the image the avatar endpoint serves (servedImage): its http(s)
 *   URL, or for an inline image this service's avatar image URL, the endpoint
 *   serving the bytes as the library resolved them (inline SVG sanitized). An
 *   image the endpoint would not serve leaves the metadata without one. Inline
 *   bytes (data: URIs, SVG markup, `image_data`) are never echoed.
 * - `image_url` is the same as `image` when it holds what the endpoint serves
 *   (it is that field, or has the same value); otherwise it is kept only as an
 *   http(s) URL (the endpoint does not serve another inline image).
 * - link fields (LINK_FIELDS) keep only http(s) values.
 * - any other string, at any depth, that is a javascript:, vbscript: or data:
 *   URL is dropped, as is anything nested deeper than MAX_META_DEPTH. (`uri`
 *   is the normalized ENS name, which cannot contain a colon.) Prose that
 *   parses as a data: URL goes too: "Data: 10,000 avatars" is dropped.
 * - `host_meta` / `is_owner` are kept only for an NFT record, where the library
 *   computes them: ens-avatar 2.0.0-alpha.2 lets a URI record's own JSON set them
 *   (e.g. a fake `is_owner: true`).
 * Other fields pass through apart from that scrub and depth limit. Only a string
 * that is a URL as a whole is scrubbed: URLs inside prose, object keys and CSS
 * values are left as they are.
 *
 * @returns the sanitized copy, or null when there's no usable image (v1 answered
 *          "No results found." for a record without one).
 */
function sanitizeAvatarMeta(
  metadata: AvatarMetadata,
  isNftRecord: boolean,
  avatarImageUrl: string | undefined,
  imageOptions: AvatarResolverOpts | undefined,
  ipfsGateway: string,
): AvatarMetadata | null {
  // The field the endpoint serves: the first non-empty string of image →
  // image_url → image_data (v1's order, and the library's), so an unusable
  // `image` is not swapped for a later field.
  const source = (['image', 'image_url', 'image_data'] as const).find(
    (key) => typeof metadata[key] === 'string' && metadata[key] !== '',
  );
  const served = servedImage(metadata, imageOptions);
  // An http(s) image on a retired gateway is fetched from the configured one.
  const image = served?.startsWith('data:')
    ? avatarImageUrl
    : parseHttpUrl(served === null ? null : toLiveGatewayUrl(served, ipfsGateway));
  if (!image) {
    return null;
  }

  const sanitized: AvatarMetadata = { ...metadata, image };
  delete sanitized.image_data;
  const imageUrl = source && metadata.image_url === metadata[source] ? image : toHttpUrl(metadata.image_url, ipfsGateway);
  if (imageUrl) {
    sanitized.image_url = imageUrl;
  } else {
    delete sanitized.image_url;
  }
  for (const key of LINK_FIELDS) {
    const url = toHttpUrl(metadata[key], ipfsGateway);
    if (url) {
      sanitized[key] = url;
    } else {
      delete sanitized[key];
    }
  }
  if (!isNftRecord) {
    delete sanitized.host_meta;
    delete sanitized.is_owner;
  }
  for (const [key, value] of Object.entries(sanitized)) {
    const clean = scrubMetaValue(value, 0);
    if (clean === undefined || key === '__proto__') {
      delete sanitized[key];
    } else {
      sanitized[key] = clean;
    }
  }
  return sanitized;
}

// The library's own fetches (NFT metadata, the image check) may name a retired
// public IPFS gateway too: ens-avatar moves only ipfs.io links.
function withLiveGateway(fetcher: Fetcher, ipfsGateway: string): Fetcher {
  return {
    get: (url, opts) => fetcher.get(toLiveGatewayUrl(url, ipfsGateway), opts),
    head: (url) => fetcher.head(toLiveGatewayUrl(url, ipfsGateway)),
    getArrayBuffer: (url, opts) => fetcher.getArrayBuffer(toLiveGatewayUrl(url, ipfsGateway), opts),
  };
}

export class AvatarService {
  private resolver: AvatarResolver;
  // Fallback resolver using the chain's default (legacy) universal resolver, set
  // only when `resolver` was pointed at a v2 universal resolver (see constructor).
  private legacyResolver?: AvatarResolver;
  private maxAvatarBytes: number;
  private ipfsGateway: string;

  constructor(
    rpcUrl: string,
    chain: Chain,
    maxAvatarBytes: number = DEFAULT_MAX_AVATAR_BYTES,
    universalResolver?: string,
    ipfsGateway: string = DEFAULT_IPFS_GATEWAY,
  ) {
    this.maxAvatarBytes = maxAvatarBytes;
    this.ipfsGateway = ipfsGateway;
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
    // inside it. ens-avatar resolves ipfs:// and ipns:// (and rewrites ipfs.io
    // links) to the configured gateway, not its ipfs.io default, and the
    // fetcher moves links on the other retired public gateways (see
    // ipfs-gateway.ts).
    const resolverOptions = {
      urlDenyList: resolverDenyList(),
      timeout: MEDIA_RESOLVE_TIMEOUT_MS,
      ipfs: ipfsGateway,
    };
    const guardedFetcher = withLiveGateway(
      createGuardedFetcher(MEDIA_RESOLVE_TIMEOUT_MS, MAX_METADATA_JSON_BYTES),
      ipfsGateway,
    );
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
   *                       only carries inline `image_data` (v1 behavior), and in
   *                       place of any other inline image (data: URI, SVG markup)
   *                       — the image endpoint materializes and sanitizes those
   *                       bytes.
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

    const resolved = await this.withLegacyFallback((resolver) =>
      this.resolveMetadataRecord(resolver, normalized, name),
    );
    if (!resolved) {
      return null;
    }

    // Resolve a usable, absolute `image` (v1 parity): explicit image → image_url →
    // (for inline on-chain images) this service's avatar image endpoint, and drop
    // what isn't safe to serve. A record with no usable image is treated as "no
    // results", matching v1's 404.
    const metadata = sanitizeAvatarMeta(
      resolved.metadata,
      resolved.isNftRecord,
      avatarImageUrl,
      resolved.options,
      this.ipfsGateway,
    );
    if (!metadata) {
      return null;
    }

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
    const timeLeft = timeLeftForAttempt(what);

    // The media timeout is created inside runInOutageScope (so the outage
    // scope is preserved) but its handle is tracked here so the outer finally
    // can clear it even when the deadline wins the race first.
    let mediaTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await runInOutageScope(scope, () => {
        const timeout = new Promise<never>((_, reject) => {
          mediaTimer = setTimeout(
            () => reject(new UpstreamError(`${what} timed out for ${name}`)),
            MEDIA_RESOLVE_TIMEOUT_MS,
          );
        });
        return raceRequestDeadline(
          Promise.race([work(), timeout]).finally(() => {
            if (mediaTimer !== undefined) clearTimeout(mediaTimer);
          }),
          timeLeft,
          what,
        );
      });
    } catch (error) {
      if (isDefinitiveMiss(error, scope.outage !== undefined)) {
        console.warn(`${what} found no usable record for ${name}:`, error);
        return null;
      }
      console.warn(`${what} failed for ${name}:`, error);
      throw error instanceof UpstreamError ? error : new UpstreamError(`${what} failed for ${name}`, { cause: error });
    } finally {
      if (mediaTimer !== undefined) clearTimeout(mediaTimer);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError(timeoutMessage)), MEDIA_RESOLVE_TIMEOUT_MS);
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * Resolve avatar-record metadata via one resolver, bounded by the media timeout,
   * plus whether the avatar record is an NFT reference and the resolver's options
   * (see sanitizeAvatarMeta). Returns null for a definitive miss and throws
   * UpstreamError when the lookup failed (see lookup).
   */
  private async resolveMetadataRecord(
    resolver: AvatarResolver,
    normalized: string,
    name: string,
  ): Promise<{ metadata: AvatarMetadata; isNftRecord: boolean; options?: AvatarResolverOpts } | null> {
    // The metadata doesn't say which kind of record it came from, so note the
    // record as the library reads it through the chain client. That happens on a
    // per-call view of the resolver (it inherits the options and fetcher), since
    // the resolver itself is shared by concurrent requests. A resolver without a
    // chain client (a stand-in) has no record to note: it counts as a non-NFT
    // record, and its errors still go through lookup().
    const seen: { record?: string | null } = {};
    const client = resolver.client;
    const scoped: AvatarResolver = client
      ? Object.create(resolver, {
          client: {
            value: Object.create(client, {
              getEnsRecord: {
                value: async (ens: string, key: string) => {
                  const result = await client.getEnsRecord(ens, key);
                  seen.record = result.record;
                  return result;
                },
              },
            }) as ChainClient,
          },
        })
      : resolver;

    const metadata = await this.lookup(
      () => scoped.getMetadata(normalized) as Promise<AvatarMetadata | null>,
      'avatar metadata resolution',
      name,
    );
    if (!metadata) {
      return null;
    }
    const isNftRecord = typeof seen.record === 'string' && NFT_RECORD.test(seen.record);
    return { metadata, isNftRecord, options: resolver.options };
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

    // Handle HTTP/HTTPS URLs (ens-avatar resolves IPFS and NFTs to HTTP URLs; an
    // NFT's image may still name a retired public IPFS gateway)
    if (uri.startsWith('http')) {
      // Validates the URL and every redirect hop (scheme, private hosts, this
      // service's own hostnames); a blocked URL throws and degrades to "none".
      const response = await fetchMediaUrl(toLiveGatewayUrl(uri, this.ipfsGateway), {
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
