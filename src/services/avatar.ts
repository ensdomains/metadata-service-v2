import { AvatarResolver } from '@ensdomains/ens-avatar';
import { fromViem } from '@ensdomains/ens-avatar/viem';
import { createPublicClient, http, isAddress, type Chain } from 'viem';
import { normalize } from '../utils/ens';

export interface AvatarImage {
  buffer: Buffer;
  mimeType: string;
}

// Hard cap on ENS media resolution (RPC + any NFT-metadata/CCIP fetch). Keeps a
// slow RPC from stalling an image request until the 30s global timeout.
const MEDIA_RESOLVE_TIMEOUT_MS = 8_000;

// Default max media image size (overridable via the MAX_AVATAR_BYTES env var).
// A user-controlled URL is fetched and (for avatars) base64-embedded into the
// generated SVG, so cap it to bound memory/output (DoS guard). NB: base64 inflates
// by ~33%, and the rendered SVG is cached in KV (25 MB value limit) — so an avatar
// above ~18 MB renders but its SVG won't fit in KV and just won't be cached.
const DEFAULT_MAX_AVATAR_BYTES = 25 * 1024 * 1024; // 25 MB

/** Detect image MIME type from magic bytes */
function detectMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  if (buffer[0] === 0x3c) return 'image/svg+xml';
  return null;
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
    this.resolver = new AvatarResolver(fromViem(client, v2UR ? { universalResolverAddress: v2UR } : undefined));
    // With a v2 resolver in front, keep a default-resolver fallback for v1/migrated
    // names the v2 resolver doesn't return. (No fallback when there's no override —
    // the primary already IS the default resolver.)
    this.legacyResolver = v2UR ? new AvatarResolver(fromViem(client)) : undefined;
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
      return await Promise.race([
        resolve,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error(`${kind} resolution timed out for ${name}`)), MEDIA_RESOLVE_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      console.warn(`${kind} resolution failed for ${name}:`, error);
      return null;
    }
  }

  /** Materialize a resolved media URI (data: or http(s)) into image bytes. */
  private async fetchMedia(uri: string, kind: string, name: string): Promise<AvatarImage | null> {
    // Handle data URIs (already base64 encoded)
    if (uri.startsWith('data:')) {
      const mimeTypeMatch = uri.match(/[^:]\w+\/[\w-+\d.]+(?=;|,)/);
      const base64data = uri.split('base64,')[1];

      if (!base64data || !mimeTypeMatch) {
        console.warn(`Invalid data URI format for ${kind} of ${name}`);
        return null;
      }

      const buffer = Buffer.from(base64data, 'base64');
      return { buffer, mimeType: mimeTypeMatch[0] };
    }

    // Handle HTTP/HTTPS URLs (ens-avatar resolves IPFS and NFTs to HTTP URLs)
    if (uri.startsWith('http')) {
      const response = await fetch(uri, {
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

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > this.maxAvatarBytes) {
        console.warn(`${kind} for ${name} too large (${arrayBuffer.byteLength} bytes)`);
        return null;
      }
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = detectMimeType(buffer) || response.headers.get('Content-Type') || 'image/png';

      return { buffer, mimeType };
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
