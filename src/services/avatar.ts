import { AvatarResolver } from '@ensdomains/ens-avatar';
import { JsonRpcProvider } from 'ethers';

export interface AvatarImage {
  buffer: Buffer;
  mimeType: string;
}

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

  constructor(rpcUrl: string) {
    // Create ethers provider for ens-avatar
    const provider = new JsonRpcProvider(rpcUrl);

    // Initialize AvatarResolver
    this.resolver = new AvatarResolver(provider);
  }

  /**
   * Get avatar image for an ENS name using @ensdomains/ens-avatar
   * Supports NFT avatars, IPFS, HTTP/HTTPS, and data URIs
   */
  async getAvatarImage(name: string): Promise<AvatarImage | null> {
    try {
      // Use ens-avatar to get avatar URI (handles NFTs, IPFS, etc.)
      const avatarURI = await this.resolver.getAvatar(name, {});

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

        const arrayBuffer = await response.arrayBuffer();
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
