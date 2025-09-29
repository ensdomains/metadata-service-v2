// SVG-based NFT image generation service for ENS domains
import { createDynamicSVGImage } from "adaptive-layout-composer";
import type { MigrationStatus } from "../types";
import { getCharacterSet } from "../utils/ens";

export interface ImageGenerationOptions {
  name: string;
  migrationStatus?: MigrationStatus;
  characterSet?: string;
  background?: "gradient" | "solid" | "pattern";
  style?: "classic" | "modern" | "minimal";
  size?: {
    width: number;
    height: number;
  };
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

  constructor() {}

  // Generate SVG image for ENS domain
  async generateDomainImage(
    options: ImageGenerationOptions,
  ): Promise<GeneratedImage> {
    const {
      name,
      migrationStatus = "unmigrated",
      background = "gradient",
      size = this.defaultSize,
    } = options;

    // Analyze domain characteristics
    const characterSet = getCharacterSet(name);

    // Choose colors based on migration status and characteristics
    const colors = this.getColorScheme(migrationStatus, characterSet);

    // Generate background
    const backgroundElement = this.generateBackground(background, colors, size);

    try {
      const svg = await createDynamicSVGImage({
        text: name,
        width: size.width,
        height: size.height,
        autoFontSize: true,
        textColor: colors.text,
        backgroundColor: colors.background,
        customElements: [
          backgroundElement,
          this.generateStatusBadge(migrationStatus, colors),
          this.generateCharacterSetIndicator(characterSet, colors),
        ].filter(Boolean),
      });

      return {
        svg,
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
      ejected: {
        background: "#DC2626", // Red
        text: "#FFFFFF",
        accent: "#FCA5A5",
        badge: "#EF4444",
      },
      shadow: {
        background: "#374151", // Cool gray
        text: "#F3F4F6",
        accent: "#9CA3AF",
        badge: "#6B7280",
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
  private generateBackground(
    type: string,
    colors: Record<string, string>,
    size: { width: number; height: number },
  ) {
    switch (type) {
      case "gradient":
        return `
          <defs>
            <linearGradient id="bg-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:${colors.background};stop-opacity:1" />
              <stop offset="100%" style="stop-color:${colors.accent};stop-opacity:1" />
            </linearGradient>
          </defs>
          <rect width="${size.width}" height="${size.height}" fill="url(#bg-gradient)" />
        `;

      case "pattern":
        return `
          <defs>
            <pattern id="bg-pattern" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
              <rect width="20" height="20" fill="${colors.background}" />
              <circle cx="10" cy="10" r="2" fill="${colors.accent}" opacity="0.3" />
            </pattern>
          </defs>
          <rect width="${size.width}" height="${size.height}" fill="url(#bg-pattern)" />
        `;

      default: // solid
        return `<rect width="${size.width}" height="${size.height}" fill="${colors.background}" />`;
    }
  }

  // Generate migration status badge
  private generateStatusBadge(status: MigrationStatus, colors: Record<string, string>) {
    const badgeText = status.toUpperCase();
    const badgeWidth = Math.max(60, badgeText.length * 8 + 20);

    return `
      <g transform="translate(10, 10)">
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
  private generateCharacterSetIndicator(characterSet: string, colors: Record<string, string>) {
    if (characterSet === "latin") return ""; // No indicator for standard latin

    const indicators = {
      emoji: "🌍",
      arabic: "ع",
      chinese: "中",
      japanese: "あ",
      korean: "한",
      mixed: "※",
    };

    const indicator =
      indicators[characterSet as keyof typeof indicators] || "◆";

    return `
      <g transform="translate(460, 10)">
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
    if (options?.style) {
      params.set("style", options.style);
    }
    if (options?.background) {
      params.set("bg", options.background);
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
