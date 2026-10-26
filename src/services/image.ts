// SVG-based NFT image generation service for ENS domains
import { createDynamicSVGImage, initializeFont } from "adaptive-layout-composer";
import { generateIdenticon } from "@ensdomains/etherloom";
import { ens_beautify } from "@adraffy/ens-normalize";
import type { MigrationStatus } from "../types";
import { namehash } from "viem/ens";
import { canonicalizeName, getCharacterSet } from "../utils/ens";
import { isOnV2 } from "../utils/migration";
import type { AvatarService } from "./avatar";
import { getSatoshiFont } from "./font";
import type { Rasterizer } from "./rasterize";
import { isSafeImageType } from "./media-safety";
import { rasterDimensions } from "./raster-dimensions";

// Standard base64 alphabet only. The avatar payload is interpolated into an SVG
// attribute, so anything else must never reach the markup.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// An avatar as the layout composer embeds it in the card (the payload is
// BASE64_RE-validated, so it cannot contain a quote), and, as a fail-closed
// backstop, any data: URI in an href attribute (resvg also renders SVG served
// as data:text/plain or data:;base64). XML attribute values are quoted, and a
// match only counts inside a tag, so a name in the card's text cannot match,
// and the pattern stays linear (one way to match any whitespace run).
// The v1 card's element has no preserveAspectRatio; the ens-v2 layout's does.
const AVATAR_ELEMENT_RE = /<image href="data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]*={0,2})" width="(\d+)" height="(\d+)"(?: preserveAspectRatio="xMidYMid slice")?\/>/g;
const DATA_HREF_RE = /<[^<>]*\bhref\s*=\s*["']\s*data:/gi;

// Names on ENS v2 (migrated or native) get the ENS v2 card; v1 names keep the
// v1 card. The v2 card's no-avatar background, as in its design: the name's etherloom
// weave on the card colour, under a 50% veil of it. The weave and its colour
// (one of the etherloom demo's identicon colours) come from the namehash of the
// canonical name alone, so they stay with the name across transfers and every
// spelling of it (the card cache is keyed by the canonical name, and viem's
// namehash does not normalize). canonicalizeName never throws, so names that
// don't normalize still get a weave. It is drawn in the composer's 550-unit
// design space, scaled like the rest of the card; the weave's own canvas is
// rounded up to whole cells, and the nested <svg> crops it.
const CARD_COLOR = "#F6FBFD";
const DESIGN_SIZE = 550;
const WEAVE_COLORS = ["#f03090", "#e8455f", "#ff9800", "#f5b400", "#2e9e5b", "#009688", "#3366cc", "#6c63ff", "#9c27b0", "#1f2937"];

export function weaveBackground(name: string, width: number, height: number): string {
  const node = namehash(canonicalizeName(name));
  const color = WEAVE_COLORS[Number(BigInt(node) % BigInt(WEAVE_COLORS.length))];
  const k = Math.min(width, height) / DESIGN_SIZE;
  const w = +(width / k).toFixed(3);
  const h = +(height / k).toFixed(3);
  const weave = generateIdenticon({ namehash: node }, color, {
    width: Math.ceil(w), height: Math.ceil(h), cellSize: 45, padding: 8, backgroundColor: CARD_COLOR,
  });
  const inner = weave.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${w} ${h}">${inner}</svg>`
    + `<rect width="${width}" height="${height}" fill="${CARD_COLOR}" opacity="0.5"/>`;
}

// Names the composer measures exactly by itself: Satoshi's Latin letters and
// digits, and CJK (drawn 1 em wide). Any other name's label is measured with
// the rasterizer, with the fonts the PNG is drawn in.
const BUILT_IN_MEASURE_RE = /^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}0-9._$-]*$/u;

// The v1 card's background colour, by character set.
function v1Background(characterSet: string): string {
  return characterSet === "emoji" ? "#FF6B6B" : characterSet === "mixed" ? "#4ECDC4" : "#1F2937";
}

// Raster formats resvg decodes (this build has no WebP decoder), and the
// largest raster avatar the Worker rasterizes. resvg allocates the whole
// decoded image in WebAssembly memory, which never shrinks for the life of the
// isolate, and decoding needs more than the bitmap: measured with this resvg
// build at 2048x2048, a PNG adds 17-29 MB, a baseline JPEG 41 MB, a GIF 52 MB
// and a progressive JPEG (possible in a 24 KB file) 66 MB, on top of ~46 MB for
// the card itself at the 2000px output size, the fonts' ~20 MB and the JS heap,
// against a 128 MB isolate. At 1024x1024 the worst case (progressive JPEG) adds
// ~16 MB. The card draws the avatar at 518px, so a 1024px avatar loses nothing
// at the default size. The payload itself is bounded too: resvg holds the SVG
// (with the base64) and the decoded file, whatever size the header declares.
const RASTERIZABLE_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const MAX_RASTERIZED_AVATAR_PIXELS = 1024 * 1024;
// Base64 characters (~4.5 MB of file): room for an uncompressed 1024x1024 RGBA PNG.
const MAX_RASTERIZED_AVATAR_BASE64 = 6 * 1024 * 1024;

// Escape user-controlled text before it is interpolated into SVG markup. The
// layout composer inlines `text` into `<text>...</text>` without escaping, so a
// name containing `<`, `&`, etc. would inject raw markup. Registered ENS names
// are ENSIP-15-normalized (no such chars) and the image routes gate on existence,
// but we escape here too as defense-in-depth — never trust the name string.
// The name as ENS shows it (ENSIP-15 ens_beautify). A normalized name has no
// FE0F, the selector that asks for an emoji's emoji form (❤ is ❤️ only with
// it), so a renderer may draw the text form or, for a ZWJ sequence such as
// 🧙🏻‍♂, nothing. Beautify puts FE0F back on every emoji (and shows ξ as Ξ, as
// ENS does). A name it cannot take is shown as given.
export function displayName(name: string): string {
  try {
    return ens_beautify(name);
  } catch {
    return name;
  }
}

function escapeXmlText(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export interface ImageGenerationOptions {
  name: string;
  // Picks the card (ENS v2 names get the ENS v2 card), its cache key and TTL.
  migrationStatus?: MigrationStatus;
  size?: {
    width: number;
    height: number;
  };
  avatarBase64?: string;
  avatarMimeType?: string;
  // The caller already looked the avatar up (avatarBase64 is unset when the
  // name has none or the lookup failed): do not look it up again.
  skipAvatarLookup?: boolean;
}

export interface GeneratedImage {
  svg: string;
  contentType: string;
  // True when the name's label was meant to be measured with the rasterizer but
  // it failed, so the card fell back to the built-in measurement and its label
  // may not fit the name. Such a card must not be cached for long.
  measureFailed: boolean;
  size: {
    width: number;
    height: number;
  };
}

export class ImageGenerationService {
  private readonly defaultSize = { width: 518, height: 518 };
  private avatarService?: AvatarService;
  // The isolate's rasterizer (getRasterizer in rasterize.ts), for measuring names.
  private rasterizer?: (bucket: R2Bucket) => Promise<Rasterizer>;

  constructor(avatarService?: AvatarService, rasterizer?: (bucket: R2Bucket) => Promise<Rasterizer>) {
    this.avatarService = avatarService;
    this.rasterizer = rasterizer;
  }

  // Generate SVG image for ENS domain
  async generateDomainImage(
    options: ImageGenerationOptions,
    bucket?: R2Bucket,
  ): Promise<GeneratedImage> {
    const { name, migrationStatus = "unmigrated", size = this.defaultSize } = options;

    let { avatarBase64, avatarMimeType } = options;

    // Fetch avatar if not provided and avatar service is available
    if (!avatarBase64 && this.avatarService && !options.skipAvatarLookup) {
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

    try {
      // The avatar becomes `<image href="data:{type};base64,{payload}">`, and the
      // layout composer does not escape that attribute. Embed it only when the
      // type is on the closed image allowlist and the payload is plain base64,
      // whatever the caller passed (e.g. a type read back from an older cache).
      const embedAvatar =
        !!avatarBase64 && isSafeImageType(avatarMimeType) && BASE64_RE.test(avatarBase64);
      if (avatarBase64 && !embedAvatar) {
        console.warn(`[image] not embedding avatar for ${name}: unsafe type ${JSON.stringify(avatarMimeType)}`);
      }
      const backgroundImageUrl = embedAvatar
        ? `data:${avatarMimeType};base64,${avatarBase64}`
        : null;

      // Load Satoshi font from R2 (memoized per isolate)
      let satoshi: { buffer: ArrayBuffer; base64: string } | undefined;
      if (bucket) {
        satoshi = await getSatoshiFont(bucket);
        await initializeFont(satoshi.buffer);
      }

      const { svg, measureFailed } = isOnV2(migrationStatus)
        ? await this.v2Card(name, size, backgroundImageUrl, satoshi, bucket)
        : { svg: await this.v1Card(name, escapeXmlText(displayName(name)), size, backgroundImageUrl, satoshi?.base64), measureFailed: false };

      return {
        svg: new TextDecoder().decode(svg),
        contentType: "image/svg+xml",
        size,
        measureFailed,
      };
    } catch (error) {
      throw new Error(`Failed to generate image for ${name}: ${error}`);
    }
  }

  // The card as it may be rasterized on this service (the /rasterize route runs
  // resvg inside the Worker). An embedded avatar is kept only if it is a PNG,
  // JPEG or GIF of at most MAX_RASTERIZED_AVATAR_BASE64 whose header declares at
  // most MAX_RASTERIZED_AVATAR_PIXELS; anything else is replaced by the card's
  // no-avatar background:
  // - an SVG avatar: rendering owner-chosen SVG costs CPU out of all proportion
  //   to its size (<use> fan-out, per-element filters, masks or group opacity,
  //   plain full-canvas fills at up to 2000px output), from under a KiB to far
  //   past the 30s CPU limit, and neither a byte cap nor a feature blocklist
  //   bounds it;
  // - a raster avatar that is too large, or whose size cannot be read: resvg
  //   decodes the full bitmap, so a small file declaring a huge size exhausts
  //   the isolate's memory;
  // - a WebP avatar: resvg cannot decode it and would leave a transparent hole.
  // `name` and `migrationStatus` must be the ones the card was generated with.
  forRasterization(svg: string, name: string, migrationStatus: MigrationStatus = "unmigrated"): string {
    let kept = 0;
    const out = svg.replace(
      AVATAR_ELEMENT_RE,
      (element, type: string, payload: string, width: string, height: string) => {
        const size = RASTERIZABLE_AVATAR_TYPES.has(type) && payload.length <= MAX_RASTERIZED_AVATAR_BASE64
          ? rasterDimensions(type, payload)
          : null;
        if (size && size.width * size.height <= MAX_RASTERIZED_AVATAR_PIXELS) {
          kept++;
          return element;
        }
        return isOnV2(migrationStatus)
          ? weaveBackground(name, Number(width), Number(height))
          : `<rect width="${width}" height="${height}" fill="${v1Background(getCharacterSet(name))}"/>`;
      },
    );
    // Every data: URI left must be an avatar vetted above; one in any other
    // markup (e.g. after a composer change) must never reach the rasterizer.
    if ((out.match(DATA_HREF_RE) ?? []).length !== kept) {
      throw new Error(`Refusing to rasterize the card for ${name}: unexpected embedded data URI`);
    }
    return out;
  }

  // The ENS v2 card. A name the composer can't measure exactly by itself is
  // measured with the rasterizer, so its label fits the name in the PNG. If
  // the rasterizer can't start, the card uses the built-in measurement and is
  // reported as measureFailed.
  private async v2Card(
    name: string,
    size: { width: number; height: number },
    backgroundImageUrl: string | null,
    satoshi: { buffer: ArrayBuffer; base64: string } | undefined,
    bucket: R2Bucket | undefined,
  ): Promise<{ svg: Uint8Array; measureFailed: boolean }> {
    const display = displayName(name);
    const options = {
      layout: 'ens-v2' as const,
      text: escapeXmlText(display),
      width: size.width,
      height: size.height,
      fontFamily: 'Satoshi',
      fontBase64: satoshi?.base64,
      backgroundImageUrl,
      backgroundMarkup: backgroundImageUrl ? null : weaveBackground(name, size.width, size.height),
    };
    if (!satoshi || !bucket || !this.rasterizer || BUILT_IN_MEASURE_RE.test(display)) {
      return { svg: await createDynamicSVGImage(options), measureFailed: false };
    }
    try {
      const rasterizer = await this.rasterizer(bucket);
      const svg = await createDynamicSVGImage({
        ...options,
        // The same buffer every time: the rasterizer parses each primary font once.
        measureText: (t, fontSize, o) => rasterizer.measureText(t, fontSize, { ...o, primaryFont: satoshi.buffer }),
      });
      return { svg, measureFailed: false };
    } catch (error) {
      console.warn(`[image] measuring ${name} with the rasterizer failed, using the built-in measurement:`, error);
      return { svg: await createDynamicSVGImage(options), measureFailed: true };
    }
  }

  // The v1 card (names not on ENS v2): the name over the avatar or a colour by
  // character set, as before, without the character-set indicator.
  private v1Card(
    name: string,
    text: string,
    size: { width: number; height: number },
    backgroundImageUrl: string | null,
    fontBase64: string | undefined,
  ): Promise<Uint8Array> {
    return createDynamicSVGImage({
      text,
      width: size.width,
      height: size.height,
      autoFontSize: true,
      maxFontSize: Math.round(32 * size.width / 270),
      fontFamily: 'Satoshi',
      fontBase64,
      textColor: '#F9FAFB',
      backgroundColor: backgroundImageUrl ? 'transparent' : v1Background(getCharacterSet(name)),
      backgroundImageUrl,
      fitMode: 'natural',
    });
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

    // Number.isInteger also rejects NaN (e.g. `?w=abc`), which passes every
    // range comparison below. A NaN size used to render a broken card that the
    // image cache then stored under the default 518x518 key.
    if (options.size) {
      const { width, height } = options.size;
      if (!Number.isInteger(width) || width < 100 || width > 2000) {
        errors.push("Width must be between 100 and 2000 pixels");
      }
      if (!Number.isInteger(height) || height < 100 || height > 2000) {
        errors.push("Height must be between 100 and 2000 pixels");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
