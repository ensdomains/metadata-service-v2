// Untrusted media handling for avatar and header bytes.
//
// An ENS name's owner chooses the URL behind its `avatar` and `header` records,
// so they also choose the server, the bytes and the Content-Type this service
// receives. Those bytes are then served on this service's own origin
// (/{network}/avatar|header/{name}) and base64-embedded into the generated NFT
// card SVG. Neither the remote Content-Type nor a declared data: URI type can be
// trusted, so:
//
//  - the type is derived ONLY from the bytes themselves, from a closed allowlist
//    of image formats (the same formats @ensdomains/ens-avatar accepts);
//  - SVG, the one scriptable format, is accepted only when its root element is
//    <svg>, and is always delivered as image/svg+xml with MEDIA_SECURITY_HEADERS
//    (no MIME sniffing, and a sandboxing CSP that forbids script, plugins and
//    network loads when the document is opened directly). Embedded in the card
//    it is an <image>, which browsers and resvg render without script or loads;
//  - anything else is rejected.
//
// SVG is deliberately NOT rewritten through @ensdomains/ens-avatar's
// sanitizeSVG here. On attacker-supplied input that sanitizer (htmlparser2,
// sanitize-html, postcss and regex CSS checks) has superlinear paths that cost
// seconds to minutes of CPU per request and can exhaust the isolate's memory,
// and they could not be bounded reliably from the outside. The headers above
// give this origin the protection that matters without parsing the document.

// Characters of the prolog (declarations, comments, DOCTYPE) inspected before
// the root element must appear.
const MAX_SVG_ROOT_SCAN = 64 * 1024;

export const SAFE_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jxl',
  'image/svg+xml',
] as const;

export type SafeImageType = (typeof SAFE_IMAGE_TYPES)[number];

export interface SafeImage {
  buffer: Buffer;
  mimeType: SafeImageType;
}

export function isSafeImageType(value: unknown): value is SafeImageType {
  return typeof value === 'string' && (SAFE_IMAGE_TYPES as readonly string[]).includes(value);
}

/**
 * Headers for every response that carries attacker-influenced media (avatar,
 * header, NFT card image). Pin the browser's interpretation: never MIME-sniff,
 * and if the document is opened directly, forbid script, plugins, forms and
 * network loads. Inline styles and data: images/fonts stay allowed because the
 * generated card SVG uses exactly those.
 */
export const MEDIA_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox",
};

function hasBytes(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function readAscii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}

// ISO-BMFF (AVIF / HEIF): an `ftyp` box at offset 4 lists a major brand at
// offset 8 and compatible brands from offset 16 to the end of the box.
function detectIsoBmffType(buf: Uint8Array): SafeImageType | null {
  if (!hasBytes(buf, ascii('ftyp'), 4)) return null;
  const boxSize = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  const end = Math.min(buf.length, boxSize >= 16 ? boxSize : 16, 4096);
  const brands = [readAscii(buf, 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(readAscii(buf, i, i + 4));

  if (brands.some((b) => b === 'avif' || b === 'avis')) return 'image/avif';
  if (brands.some((b) => ['heic', 'heix', 'hevc', 'hevx'].includes(b))) return 'image/heic';
  if (brands.some((b) => b === 'mif1' || b === 'msf1')) return 'image/heif';
  return null;
}

/** Classify raster image bytes by file signature. Never consults a declared type. */
export function detectRasterType(buf: Uint8Array): SafeImageType | null {
  if (hasBytes(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (hasBytes(buf, ascii('GIF87a')) || hasBytes(buf, ascii('GIF89a'))) return 'image/gif';
  if (hasBytes(buf, ascii('RIFF')) && hasBytes(buf, ascii('WEBP'), 8)) return 'image/webp';
  // BMP: "BM", then a 4-byte file size and 4 reserved zero bytes.
  if (hasBytes(buf, ascii('BM')) && hasBytes(buf, [0, 0, 0, 0], 6)) return 'image/bmp';
  const isoBmff = detectIsoBmffType(buf);
  if (isoBmff) return isoBmff;
  // JPEG XL: bare codestream, or the ISO-BMFF-style container signature.
  if (hasBytes(buf, [0xff, 0x0a])) return 'image/jxl';
  if (hasBytes(buf, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) return 'image/jxl';
  return null;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
  return i;
}

/**
 * True when the bytes are an XML document whose root element is <svg>: after an
 * optional BOM, only whitespace, an XML declaration or other processing
 * instructions, comments and a DOCTYPE naming svg may precede it. HTML (for
 * example `<!DOCTYPE html>` or `<html>`) and anything else is rejected. One
 * forward scan over at most MAX_SVG_ROOT_SCAN characters of the start.
 */
export function isSvgDocument(buf: Uint8Array): boolean {
  // TextDecoder drops a leading UTF-8 BOM.
  const text = new TextDecoder().decode(buf.subarray(0, MAX_SVG_ROOT_SCAN));
  let i = skipSpace(text, 0);
  for (;;) {
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return false;
      i = skipSpace(text, end + 2);
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = skipSpace(text, end + 3);
    } else if (text.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
      // The DOCTYPE must name svg; an internal subset [...] may contain '>'.
      const nameStart = skipSpace(text, i + 9);
      if (!/^svg[\s>[]/.test(text.slice(nameStart, nameStart + 4))) return false;
      const bracket = text.indexOf('[', nameStart);
      const gt = text.indexOf('>', nameStart);
      if (gt < 0) return false;
      if (bracket >= 0 && bracket < gt) {
        const close = text.indexOf(']', bracket);
        if (close < 0) return false;
        const end = text.indexOf('>', close);
        if (end < 0) return false;
        i = skipSpace(text, end + 1);
      } else {
        i = skipSpace(text, gt + 1);
      }
    } else {
      break;
    }
  }
  return /^<svg[\s>/]/.test(text.slice(i, i + 5));
}

/**
 * Turn untrusted media bytes into bytes that are safe to serve on this origin
 * (with MEDIA_SECURITY_HEADERS) or embed in the NFT card: allowlisted raster
 * formats and SVG documents pass through unchanged with a type taken from the
 * bytes; anything else is rejected (null).
 */
export function toSafeImage(bytes: Uint8Array): SafeImage | null {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raster = detectRasterType(buffer);
  if (raster) return { buffer, mimeType: raster };
  return isSvgDocument(buffer) ? { buffer, mimeType: 'image/svg+xml' } : null;
}
