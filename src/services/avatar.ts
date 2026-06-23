import { AvatarResolver } from '@ensdomains/ens-avatar';
import { fromViem } from '@ensdomains/ens-avatar/viem';
import { createPublicClient, http, type Chain } from 'viem';
import { normalize } from '../utils/ens';

export interface AvatarImage {
  buffer: Buffer;
  mimeType: string;
}

// Hard cap on ENS avatar resolution (RPC + any NFT-metadata/CCIP fetch). Keeps a
// slow mainnet RPC from stalling an image request until the 30s global timeout.
const AVATAR_RESOLVE_TIMEOUT_MS = 8_000;

// Default max avatar image size (overridable via the MAX_AVATAR_BYTES env var).
// A user-controlled avatar URL is fetched and base64-embedded into the generated
// SVG, so cap it to bound memory/output (DoS guard). NB: base64 inflates by ~33%,
// and the rendered SVG is cached in KV (25 MB value limit) — so an avatar above
// ~18 MB renders but its SVG won't fit in KV and just won't be cached.
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
  private maxAvatarBytes: number;

  constructor(rpcUrl: string, chain: Chain, maxAvatarBytes: number = DEFAULT_MAX_AVATAR_BYTES) {
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
    // ens-avatar 2.x (≥ alpha.2) loosened ViemClientLike.readContract so a stock
    // viem PublicClient assigns directly — no cast needed.
    this.resolver = new AvatarResolver(fromViem(client));
  }

  /**
   * Get avatar image for an ENS name using @ensdomains/ens-avatar
   * Supports NFT avatars, IPFS, HTTP/HTTPS, and data URIs
   */
  async getAvatarImage(name: string): Promise<AvatarImage | null> {
    try {
      // viem's ENS resolution requires ENSIP-15-normalized names (the fromViem
      // adapter passes the name through as-is). A non-normalizable name can't have
      // a resolvable avatar → treat as none.
      let normalized: string;
      try {
        normalized = normalize(name);
      } catch {
        return null;
      }

      // Hard cap on the whole resolution (text-record + address + any NFT metadata
      // fetch the resolver does internally), so a slow RPC/gateway degrades to
      // "no avatar" in seconds instead of stalling until the global request timeout.
      const avatarURI = await Promise.race([
        this.resolver.getAvatar(normalized, {}),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error(`avatar resolution timed out for ${name}`)), AVATAR_RESOLVE_TIMEOUT_MS),
        ),
      ]);

      if (!avatarURI) {
        return null;
      }

      // Handle data URIs (already base64 encoded)
      if (avatarURI.startsWith('data:')) {
        const mimeTypeMatch = avatarURI.match(/[^:]\w+\/[\w-+\d.]+(?=;|,)/);
        const base64data = avatarURI.split('base64,')[1];

        if (!base64data || !mimeTypeMatch) {
          console.warn(`Invalid data URI format for ${name}`);
          return null;
        }

        const buffer = Buffer.from(base64data, 'base64');
        return { buffer, mimeType: mimeTypeMatch[0] };
      }

      // Handle HTTP/HTTPS URLs (ens-avatar resolves IPFS and NFTs to HTTP URLs)
      if (avatarURI.startsWith('http')) {
        const response = await fetch(avatarURI, {
          signal: AbortSignal.timeout(7000),
          headers: {
            'user-agent': 'ENS-Metadata-V2/1.0.0',
          },
        });

        if (!response.ok) {
          console.warn(`Failed to fetch avatar for ${name}: ${response.status}`);
          return null;
        }

        // Cap the avatar size: a user-controlled avatar URL could serve an
        // arbitrarily large body (memory/DoS, and it gets base64-embedded into the
        // SVG). Reject early on a declared oversize, then bound the actual bytes.
        const declared = Number(response.headers.get('Content-Length') ?? '');
        if (Number.isFinite(declared) && declared > this.maxAvatarBytes) {
          console.warn(`Avatar for ${name} too large (Content-Length ${declared})`);
          return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > this.maxAvatarBytes) {
          console.warn(`Avatar for ${name} too large (${arrayBuffer.byteLength} bytes)`);
          return null;
        }
        const buffer = Buffer.from(arrayBuffer);
        const mimeType = detectMimeType(buffer) || response.headers.get('Content-Type') || 'image/png';

        return { buffer, mimeType };
      }

      console.warn(`Unsupported avatar URI format for ${name}: ${avatarURI}`);
      return null;
    } catch (error) {
      console.warn(`Error fetching avatar for ${name}:`, error);
      return null;
    }
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
