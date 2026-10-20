// SVG-based NFT image generation service for ENS domains
import { createDynamicSVGImage, initializeFont } from "adaptive-layout-composer";
import { generateIdenticon } from "@ensdomains/etherloom";
import { ens_beautify } from "@adraffy/ens-normalize";
import type { MigrationStatus } from "../types";
import { namehash } from "viem/ens";
import { getCharacterSet, isNormalized, maskedName } from "../utils/ens";
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
// weave on the card colour, under a 50% veil of it. The weave and the card's theme
// come from the namehash alone, so they stay with the name across transfers. It is
// drawn in the composer's 550-unit design space, scaled like the rest of the card;
// the weave's own canvas is rounded up to whole cells, and the nested <svg> crops it.
const DESIGN_SIZE = 550;

// The Name NFT design's themes: `accent` is the logo tile, name and square; `card`
// is the background and the label; `weave` is chosen so that, under the veil, the
// weave's main tone is the design's pattern colour.
const CARD_THEMES = [
  { accent: "#0082BB", card: "#F6FBFD", weave: "#80C4E0" },
  { accent: "#984D1B", card: "#FCFCF2", weave: "#E0B67E" },
  { accent: "#007C20", card: "#E8F6EF", weave: "#74AC7D" },
  { accent: "#353535", card: "#FAF9F6", weave: "#C6C7C4" },
  { accent: "#E72A96", card: "#FDF1F4", weave: "#FFB1D0" },
] as const;

export function cardTheme(name: string) {
  return CARD_THEMES[Number(BigInt(namehash(name)) % BigInt(CARD_THEMES.length))];
}

export function weaveBackground(name: string, width: number, height: number): string {
  const node = namehash(name);
  const theme = cardTheme(name);
  const k = Math.min(width, height) / DESIGN_SIZE;
  const w = +(width / k).toFixed(3);
  const h = +(height / k).toFixed(3);
  const weave = generateIdenticon({ namehash: node }, theme.weave, {
    width: Math.ceil(w), height: Math.ceil(h), cellSize: 45, padding: 8, backgroundColor: theme.card,
  });
  const inner = weave.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${w} ${h}">${inner}</svg>`
    + `<rect width="${width}" height="${height}" fill="${theme.card}" opacity="0.5"/>`;
}

// Names the composer measures exactly by itself: Satoshi's Latin letters and
// digits, and CJK (drawn 1 em wide). Any other name's label is measured with
// the rasterizer, with the fonts the PNG is drawn in.
const BUILT_IN_MEASURE_RE = /^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}0-9._$-]*$/u;

// v1's card for a name that isn't normalized (ens-metadata-service
// src/svg-template.ts): its red gradient, warning sign and "Invalid name", in
// v1's 270-unit space, on the v1 layout.
const INVALID_NAME_MARKS = "<rect x=\"200\" y=\"34\" width=\"40\" height=\"40\" rx=\"20\" fill=\"white\" fill-opacity=\"0.2\"/><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M217.472 44.4655C218.581 42.5115 221.42 42.5115 222.528 44.4655L230.623 58.7184C231.711 60.6351 230.314 63 228.096 63H211.905C209.686 63 208.289 60.6351 209.377 58.7184L217.472 44.4655ZM221.451 58.6911C221.451 59.0722 221.298 59.4376 221.026 59.7071C220.754 59.9765 220.385 60.1279 220 60.1279C219.615 60.1279 219.246 59.9765 218.974 59.7071C218.702 59.4376 218.549 59.0722 218.549 58.6911C218.549 58.31 218.702 57.9446 218.974 57.6751C219.246 57.4057 219.615 57.2543 220 57.2543C220.385 57.2543 220.754 57.4057 221.026 57.6751C221.298 57.9446 221.451 58.31 221.451 58.6911V58.6911ZM220 47.1968C219.615 47.1968 219.246 47.3482 218.974 47.6177C218.702 47.8871 218.549 48.2526 218.549 48.6336V52.944C218.549 53.325 218.702 53.6905 218.974 53.9599C219.246 54.2294 219.615 54.3807 220 54.3807C220.385 54.3807 220.754 54.2294 221.026 53.9599C221.298 53.6905 221.451 53.325 221.451 52.944V48.6336C221.451 48.2526 221.298 47.8871 221.026 47.6177C220.754 47.3482 220.385 47.1968 220 47.1968Z\" fill=\"white\"/><path opacity=\"0.6\" d=\"M36.791 196V183.947H34.411V196H36.791ZM41.6133 191.189C41.6133 190.22 42.1913 189.455 43.1773 189.455C44.2653 189.455 44.7243 190.186 44.7243 191.121V196H46.9853V190.73C46.9853 188.894 46.0333 187.415 43.9593 187.415C43.0583 187.415 42.0553 187.806 41.5453 188.673V187.636H39.3523V196H41.6133V191.189ZM56.9874 187.636H54.6074L52.6184 193.246L50.5444 187.636H48.0624L51.4794 196H53.7404L56.9874 187.636ZM57.6689 193.722C57.6689 195.031 58.7569 196.238 60.5419 196.238C61.7829 196.238 62.5819 195.66 63.0069 194.997C63.0069 195.32 63.0409 195.779 63.0919 196H65.1659C65.1149 195.711 65.0639 195.116 65.0639 194.674V190.56C65.0639 188.877 64.0779 187.381 61.4259 187.381C59.1819 187.381 57.9749 188.826 57.8389 190.135L59.8449 190.56C59.9129 189.829 60.4569 189.2 61.4429 189.2C62.3949 189.2 62.8539 189.693 62.8539 190.288C62.8539 190.577 62.7009 190.815 62.2249 190.883L60.1679 191.189C58.7739 191.393 57.6689 192.226 57.6689 193.722ZM61.0179 194.555C60.2869 194.555 59.9299 194.079 59.9299 193.586C59.9299 192.94 60.3889 192.617 60.9669 192.532L62.8539 192.243V192.617C62.8539 194.096 61.9699 194.555 61.0179 194.555ZM69.5703 196V183.692H67.3093V196H69.5703ZM74.1358 196V187.636H71.8748V196H74.1358ZM71.6028 184.899C71.6028 185.647 72.2318 186.276 72.9968 186.276C73.7788 186.276 74.3908 185.647 74.3908 184.899C74.3908 184.117 73.7788 183.488 72.9968 183.488C72.2318 183.488 71.6028 184.117 71.6028 184.899ZM84.5322 183.692H82.3052V188.469C82.0672 188.027 81.3872 187.432 79.9422 187.432C77.5792 187.432 75.9302 189.353 75.9302 191.801C75.9302 194.334 77.6302 196.204 80.0102 196.204C81.1322 196.204 81.9822 195.694 82.3562 195.031C82.3562 195.422 82.4072 195.83 82.4412 196H84.6002C84.5662 195.66 84.5322 195.048 84.5322 194.487V183.692ZM78.2082 191.801C78.2082 190.305 79.1262 189.455 80.2822 189.455C81.4382 189.455 82.3392 190.288 82.3392 191.784C82.3392 193.297 81.4382 194.181 80.2822 194.181C79.0922 194.181 78.2082 193.297 78.2082 191.801ZM93.1445 191.189C93.1445 190.22 93.7225 189.455 94.7085 189.455C95.7965 189.455 96.2555 190.186 96.2555 191.121V196H98.5165V190.73C98.5165 188.894 97.5645 187.415 95.4905 187.415C94.5895 187.415 93.5865 187.806 93.0765 188.673V187.636H90.8835V196H93.1445V191.189ZM100.252 193.722C100.252 195.031 101.34 196.238 103.125 196.238C104.366 196.238 105.165 195.66 105.59 194.997C105.59 195.32 105.624 195.779 105.675 196H107.749C107.698 195.711 107.647 195.116 107.647 194.674V190.56C107.647 188.877 106.661 187.381 104.009 187.381C101.765 187.381 100.558 188.826 100.422 190.135L102.428 190.56C102.496 189.829 103.04 189.2 104.026 189.2C104.978 189.2 105.437 189.693 105.437 190.288C105.437 190.577 105.284 190.815 104.808 190.883L102.751 191.189C101.357 191.393 100.252 192.226 100.252 193.722ZM103.601 194.555C102.87 194.555 102.513 194.079 102.513 193.586C102.513 192.94 102.972 192.617 103.55 192.532L105.437 192.243V192.617C105.437 194.096 104.553 194.555 103.601 194.555ZM112.153 196V191.104C112.153 190.186 112.731 189.455 113.717 189.455C114.737 189.455 115.196 190.135 115.196 191.036V196H117.44V191.104C117.44 190.203 118.018 189.455 118.987 189.455C120.024 189.455 120.466 190.135 120.466 191.036V196H122.659V190.577C122.659 188.333 121.18 187.398 119.633 187.398C118.528 187.398 117.644 187.772 116.981 188.792C116.556 187.891 115.638 187.398 114.499 187.398C113.581 187.398 112.51 187.84 112.051 188.656V187.636H109.892V196H112.153ZM126.669 190.866C126.72 190.101 127.366 189.217 128.539 189.217C129.831 189.217 130.375 190.033 130.409 190.866H126.669ZM130.63 193.042C130.358 193.79 129.78 194.317 128.726 194.317C127.604 194.317 126.669 193.518 126.618 192.413H132.602C132.602 192.379 132.636 192.039 132.636 191.716C132.636 189.03 131.089 187.381 128.505 187.381C126.363 187.381 124.391 189.115 124.391 191.784C124.391 194.606 126.414 196.255 128.709 196.255C130.766 196.255 132.092 195.048 132.517 193.603L130.63 193.042Z\" fill=\"white\"/>";

function invalidNameGradient(width: number, height: number): string {
  return `<defs><linearGradient id="invalidName" x1="0" y1="0" x2="269.553" y2="285.527" gradientUnits="userSpaceOnUse" gradientTransform="scale(${width / 270} ${height / 270})">`
    + `<stop stop-color="#EB9E9E"/><stop offset="1" stop-color="#992222"/></linearGradient></defs>`;
}

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
  // The route's token type: a name that isn't normalized shows its token id.
  registryType?: 'registry' | 'namewrapper';
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
    // As in v1, a name that isn't normalized gets no avatar.
    if (!avatarBase64 && this.avatarService && !options.skipAvatarLookup && isNormalized(name)) {
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

      const result = !isNormalized(name)
        ? await this.invalidNameCard(name, options.registryType ?? 'registry', size, satoshi?.base64)
        : isOnV2(migrationStatus)
        ? await this.v2Card(name, size, backgroundImageUrl, satoshi, bucket)
        : await this.v1Card(name, escapeXmlText(displayName(name)), size, backgroundImageUrl, satoshi?.base64);

      return {
        svg: new TextDecoder().decode(result),
        contentType: "image/svg+xml",
        size,
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
  // the rasterizer can't start, the card uses the built-in measurement.
  private async v2Card(
    name: string,
    size: { width: number; height: number },
    backgroundImageUrl: string | null,
    satoshi: { buffer: ArrayBuffer; base64: string } | undefined,
    bucket: R2Bucket | undefined,
  ): Promise<Uint8Array> {
    const display = displayName(name);
    const theme = cardTheme(name);
    const options = {
      layout: 'ens-v2' as const,
      colors: { accent: theme.accent, label: theme.card, logo: theme.card },
      text: escapeXmlText(display),
      width: size.width,
      height: size.height,
      fontFamily: 'Satoshi',
      fontBase64: satoshi?.base64,
      backgroundImageUrl,
      backgroundMarkup: backgroundImageUrl ? null : weaveBackground(name, size.width, size.height),
    };
    if (!satoshi || !bucket || !this.rasterizer || BUILT_IN_MEASURE_RE.test(display)) return createDynamicSVGImage(options);
    try {
      const rasterizer = await this.rasterizer(bucket);
      return await createDynamicSVGImage({
        ...options,
        // The same buffer every time: the rasterizer parses each primary font once.
        measureText: (t, fontSize, o) => rasterizer.measureText(t, fontSize, { ...o, primaryFont: satoshi.buffer }),
      });
    } catch (error) {
      console.warn(`[image] measuring ${name} with the rasterizer failed, using the built-in measurement:`, error);
      return createDynamicSVGImage(options);
    }
  }

  // v1's card for a name that isn't normalized: the token id, shortened, never
  // the name (it can pass for another name), on the red gradient with a warning
  // sign and "Invalid name". The gradient is defined in the custom elements.
  private invalidNameCard(
    name: string,
    registryType: 'registry' | 'namewrapper',
    size: { width: number; height: number },
    fontBase64: string | undefined,
  ): Promise<Uint8Array> {
    return createDynamicSVGImage({
      text: maskedName(name, registryType),
      width: size.width,
      height: size.height,
      autoFontSize: true,
      maxFontSize: Math.round(32 * size.width / 270),
      fontFamily: 'Satoshi',
      fontBase64,
      backgroundColor: 'url(#invalidName)',
      customElements: [
        `<g transform="scale(${Math.min(size.width, size.height) / 270})">${INVALID_NAME_MARKS}</g>`,
        invalidNameGradient(size.width, size.height),
      ],
      fitMode: 'natural',
    });
  }

  // The v1 card (names not on ENS v2), unchanged: the name over the avatar or
  // a colour by character set. No badge or indicator.
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
