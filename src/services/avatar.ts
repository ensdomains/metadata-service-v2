import { AvatarResolver } from '@ensdomains/ens-avatar';
import { fromViem } from '@ensdomains/ens-avatar/viem';
import { createPublicClient, http, isAddress, type Chain } from 'viem';
import { fetchMediaUrl, readBodyCapped, resolverDenyList } from './media-fetch';
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

// Per-request timeout for the ens-avatar resolver's own HTTP fetches (metadata
// JSON, HEAD checks). Kept under MEDIA_RESOLVE_TIMEOUT_MS; the library default
// is 30s, which outlived the race above and matched the whole request budget.
const RESOLVER_FETCH_TIMEOUT_MS = 7_000;

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
      transport: http(rpcUrl, { timeout: 6_000, retryCount: 1 }),
    });

    // Native-v2 names live in the v2 registry, which viem's stock universal
    // resolver doesn't traverse — so their avatar/header records resolve to null.
    // When a v2 universal resolver is configured (e.g. Sepolia), route record
    // lookups through it. `{ strict: false }` accepts lowercase config addresses;
    // an unset/placeholder value falls back to viem's default resolver.
    const v2UR = isAddress(universalResolver ?? '', { strict: false }) ? universalResolver : undefined;
    // Never let a record resolve to this service itself (anti-recursion); the
    // library's private-address checks stay on (allowPrivateIPs defaults false).
    const resolverOptions = { urlDenyList: resolverDenyList(), timeout: RESOLVER_FETCH_TIMEOUT_MS };
    this.resolver = new AvatarResolver(
      fromViem(client, v2UR ? { universalResolverAddress: v2UR } : undefined),
      resolverOptions,
    );
    // With a v2 resolver in front, keep a default-resolver fallback for v1/migrated
    // names the v2 resolver doesn't return. (No fallback when there's no override —
    // the primary already IS the default resolver.)
    this.legacyResolver = v2UR ? new AvatarResolver(fromViem(client), resolverOptions) : undefined;
  }

  /**
   * Get avatar image for an ENS name using @ensdomains/ens-avatar.
   * Supports NFT avatars, IPFS, HTTP/HTTPS, and data URIs.
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
   * v1/migrated names, a hard timeout, and graceful degradation to null.
   *
   * @param name           the ENS name.
   * @param avatarImageUrl absolute URL of THIS deployment's avatar *image* endpoint
   *                       for `name`. Used as the `image` value when the record
   *                       only carries inline `image_data` (v1 behavior) — the
   *                       image endpoint materializes and sanitizes those bytes.
   * @returns the metadata, or null when there's no resolvable avatar with a usable
   *          image (the route maps null → 404 "No results found.").
   */
  async getAvatarMeta(name: string, avatarImageUrl?: string): Promise<AvatarMetadata | null> {
    // A non-normalizable name can't have a resolvable record (same gate as media).
    let normalized: string;
    try {
      normalized = normalize(name);
    } catch {
      return null;
    }

    let metadata = await this.resolveMetadataRecord(this.resolver, normalized, name);
    if (!metadata && this.legacyResolver) {
      metadata = await this.resolveMetadataRecord(this.legacyResolver, normalized, name);
    }
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
   * record URI via ens-avatar, then materializes it (data URI or HTTP fetch),
   * degrading to null on any failure so the caller can render without it.
   */
  private async resolveMedia(kind: 'avatar' | 'header', name: string): Promise<AvatarImage | null> {
    try {
      // viem's ENS resolution requires ENSIP-15-normalized names (the fromViem
      // adapter passes the name through as-is). A non-normalizable name can't have
      // a resolvable record → treat as none.
      let normalized: string;
      try {
        normalized = normalize(name);
      } catch {
        return null;
      }

      // Resolve via the (possibly v2) primary resolver; if it finds nothing and a
      // legacy-resolver fallback exists, try that too (v1/migrated names).
      let uri = await this.resolveRecord(this.resolver, kind, normalized, name);
      if (!uri && this.legacyResolver) {
        uri = await this.resolveRecord(this.legacyResolver, kind, normalized, name);
      }

      if (!uri) {
        return null;
      }

      return await this.fetchMedia(uri, kind, name);
    } catch (error) {
      console.warn(`Error fetching ${kind} for ${name}:`, error);
      return null;
    }
  }

  /**
   * Resolve a single media record via one resolver, bounded by a hard timeout so a
   * slow RPC/gateway degrades to "none" instead of stalling until the global
   * request timeout. Returns null (rather than throwing) on timeout/error so a
   * caller can fall through to another resolver.
   */
  private async resolveRecord(
    resolver: AvatarResolver,
    kind: 'avatar' | 'header',
    normalized: string,
    name: string,
  ): Promise<string | null> {
    try {
      const resolve = kind === 'avatar'
        ? resolver.getAvatar(normalized, {})
        : resolver.getHeader(normalized, {});
      return await this.withMediaTimeout(resolve, `${kind} resolution timed out for ${name}`);
    } catch (error) {
      console.warn(`${kind} resolution failed for ${name}:`, error);
      return null;
    }
  }

  /**
   * Race a media-resolution promise against the hard timeout (MEDIA_RESOLVE_TIMEOUT_MS)
   * so a slow RPC/gateway degrades to "none" instead of stalling until the global
   * request timeout. Rejects with `timeoutMessage` on expiry.
   */
  private withMediaTimeout<T>(work: Promise<T>, timeoutMessage: string): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(timeoutMessage)), MEDIA_RESOLVE_TIMEOUT_MS),
      ),
    ]);
  }

  /**
   * Resolve avatar-record metadata via one resolver, bounded by the media timeout.
   * Returns null (never throws) on timeout/error so the caller can fall through to
   * the legacy resolver or degrade to "no results".
   */
  private async resolveMetadataRecord(
    resolver: AvatarResolver,
    normalized: string,
    name: string,
  ): Promise<AvatarMetadata | null> {
    try {
      const meta = await this.withMediaTimeout(
        resolver.getMetadata(normalized),
        `avatar metadata resolution timed out for ${name}`,
      );
      return meta as AvatarMetadata | null;
    } catch (error) {
      console.warn(`avatar metadata resolution failed for ${name}:`, error);
      return null;
    }
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
      if (arrayBuffer.byteLength > this.maxAvatarBytes) {
        console.warn(`${kind} for ${name} too large (${arrayBuffer.byteLength} bytes)`);
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
