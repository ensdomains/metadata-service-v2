// SVG-based NFT image generation service for ENS domains
import { createDynamicSVGImage, initializeFont } from "adaptive-layout-composer";
import { MIGRATION_STATUS, type MigrationStatus } from "../types";
import { getCharacterSet } from "../utils/ens";
import type { AvatarService } from "./avatar";
import { getSatoshiFont } from "./font";

export interface ImageGenerationOptions {
  name: string;
  migrationStatus?: MigrationStatus;
  characterSet?: string;
  size?: {
    width: number;
    height: number;
  };
  avatarBase64?: string;
  avatarMimeType?: string;
}

export interface GeneratedImage {
  svg: string;
  contentType: string;
  size: {
    width: number;
    height: number;
  };
}

export class ImageGenerationService {
  private readonly defaultSize = { width: 518, height: 518 };
  private avatarService?: AvatarService;

  constructor(avatarService?: AvatarService) {
    this.avatarService = avatarService;
  }

  // Generate SVG image for ENS domain
  async generateDomainImage(
    options: ImageGenerationOptions,
    bucket?: R2Bucket,
  ): Promise<GeneratedImage> {
    const {
      name,
      migrationStatus = "unmigrated",
      size = this.defaultSize,
    } = options;

    let { avatarBase64, avatarMimeType } = options;

    // Fetch avatar if not provided and avatar service is available
    if (!avatarBase64 && this.avatarService) {
      try {
        const avatar = await this.avatarService.getAvatarBase64(name);
        if (avatar) {
          avatarBase64 = avatar.base64;
          avatarMimeType = avatar.mimeType;
        }
      } catch (error) {
        console.warn(`Failed to fetch avatar for ${name}:`, error);
      }
    }

    // Analyze domain characteristics
    const characterSet = getCharacterSet(name);

    // Choose colors based on migration status and characteristics
    const colors = this.getColorScheme(migrationStatus, characterSet);

    try {
      // Create data URI for avatar if available
      const backgroundImageUrl = avatarBase64
        ? `data:${avatarMimeType};base64,${avatarBase64}`
        : null;

      // Load Satoshi font from R2 (memoized per isolate)
      let satoshiFontBase64: string | undefined;
      if (bucket) {
        const satoshi = await getSatoshiFont(bucket);
        await initializeFont(satoshi.buffer);
        satoshiFontBase64 = satoshi.base64;
      }

      const result = await createDynamicSVGImage({
        text: name,
        width: size.width,
        height: size.height,
        autoFontSize: true,
        maxFontSize: Math.round(32 * size.width / 270),
        fontFamily: 'Satoshi',
        fontBase64: satoshiFontBase64,
        textColor: colors.text,
        backgroundColor: avatarBase64 ? 'transparent' : colors.background,
        backgroundImageUrl,
        customElements: [
          this.generateStatusBadge(migrationStatus, colors, size.width, characterSet !== "letter" && characterSet !== "digit" && characterSet !== "alphanumeric"),
          this.generateCharacterSetIndicator(characterSet, colors, size.width),
        ].filter(Boolean),
        fitMode: 'natural',
      });

      // The result might be a string, Buffer, typed array, or an object with svg property
      let svg: string;
      if (typeof result === 'string') {
        svg = result;
      } else if (Buffer.isBuffer(result)) {
        svg = result.toString('utf-8');
      } else if (result && typeof result === 'object' && 'length' in result && typeof result[0] === 'number') {
        // It's an array-like object with numeric values (Uint8Array or similar)
        // Convert to Buffer first, then to string
        const buffer = Buffer.from(result as any);
        svg = buffer.toString('utf-8');
      } else if (result && typeof result === 'object' && 'svg' in result) {
        svg = String((result as any).svg);
      } else {
        svg = String(result);
      }

      return {
        svg: typeof svg === 'string' ? svg : String(svg),
        contentType: "image/svg+xml",
        size,
      };
    } catch (error) {
      throw new Error(`Failed to generate image for ${name}: ${error}`);
    }
  }

  // Get color scheme based on domain characteristics
  private getColorScheme(
    migrationStatus: MigrationStatus,
    characterSet: string,
  ) {
    const schemes = {
      migrated: {
        background: "#4F46E5", // Indigo
        text: "#FFFFFF",
        accent: "#818CF8",
        badge: "#10B981", // Green
      },
      native: {
        background: "#7C3AED", // Purple
        text: "#FFFFFF",
        accent: "#A78BFA",
        badge: "#8B5CF6",
      },
      unmigrated: {
        background: "#1F2937", // Gray
        text: "#F9FAFB",
        accent: "#6B7280",
        badge: "#F59E0B", // Amber
      },
    };

    let baseScheme = schemes[migrationStatus] || schemes.unmigrated;

    // Modify colors based on character set
    if (characterSet === "emoji") {
      baseScheme = {
        ...baseScheme,
        background: "#FF6B6B", // Warm red for emoji domains
        accent: "#FFE66D",
      };
    } else if (characterSet === "mixed") {
      baseScheme = {
        ...baseScheme,
        background: "#4ECDC4", // Teal for mixed character domains
        accent: "#95E1D3",
      };
    }

    return baseScheme;
  }

  // Generate background element
  // Generate migration status badge
  private generateStatusBadge(status: MigrationStatus, colors: Record<string, string>, width: number = 518, hasCharIndicator: boolean = false) {
    // Don't show migration badge until v2 is live (all mainnet names are 'unmigrated' for now)
    if (status === MIGRATION_STATUS.UNMIGRATED) return '';

    const badgeText = status.toUpperCase();
    const badgeWidth = Math.max(60, badgeText.length * 8 + 20);
    const rightOffset = hasCharIndicator ? 50 : 10;
    const x = width - badgeWidth - rightOffset;
    const y = 13; // vertically centered with 30px character indicator circle

    return `
      <g transform="translate(${x}, ${y})">
        <rect width="${badgeWidth}" height="24" rx="12" fill="${colors.badge}" opacity="0.9" />
        <text x="${badgeWidth / 2}" y="16"
              text-anchor="middle"
              font-family="Arial, sans-serif"
              font-size="10"
              font-weight="bold"
              fill="white">
          ${badgeText}
        </text>
      </g>
    `;
  }

  // Generate character set indicator
  private generateCharacterSetIndicator(characterSet: string, colors: Record<string, string>, width: number = 518) {
    // No indicator for standard letter/digit/alphanumeric names
    if (characterSet === "letter" || characterSet === "digit" || characterSet === "alphanumeric") return "";

    const indicators: Record<string, string> = {
      emoji: "🌍",
      mixed: "※",
    };

    const indicator = indicators[characterSet] || "◆";
    const x = width - 40;

    return `
      <g transform="translate(${x}, 10)">
        <circle cx="15" cy="15" r="15" fill="${colors.accent}" opacity="0.8" />
        <text x="15" y="20"
              text-anchor="middle"
              font-family="Arial, sans-serif"
              font-size="16"
              fill="${colors.text}">
          ${indicator}
        </text>
      </g>
    `;
  }

  // Generate image URL for metadata
  getImageUrl(
    name: string,
    baseUrl: string,
    options?: Partial<ImageGenerationOptions>,
  ): string {
    const params = new URLSearchParams();

    if (options?.migrationStatus) {
      params.set("status", options.migrationStatus);
    }
    if (options?.size) {
      params.set("w", options.size.width.toString());
      params.set("h", options.size.height.toString());
    }

    const queryString = params.toString();
    return `${baseUrl}/${encodeURIComponent(name)}/image${queryString ? `?${queryString}` : ""}`;
  }

  // Validate image generation parameters
  validateOptions(options: ImageGenerationOptions): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!options.name || options.name.trim().length === 0) {
      errors.push("Domain name is required");
    }

    if (options.size) {
      if (options.size.width < 100 || options.size.width > 2000) {
        errors.push("Width must be between 100 and 2000 pixels");
      }
      if (options.size.height < 100 || options.size.height > 2000) {
        errors.push("Height must be between 100 and 2000 pixels");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
