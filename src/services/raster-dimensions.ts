// Pixel dimensions of a raster image, read from its header without decoding
// the pixels, for the formats resvg decodes when rasterizing the NFT card
// (PNG, JPEG, GIF, WebP). resvg allocates the full decoded bitmap, so the
// declared size (not the file size) is what a render costs: a 61 KiB all-zero
// PNG declaring 8000x8000 pixels takes ~0.4 GB. The bytes are read from the
// base64 payload a window at a time, so a large avatar is never decoded whole.

export interface RasterDimensions {
  width: number;
  height: number;
}

// How far into the file a header may be (JPEG can carry EXIF/ICC segments
// before its frame header). Past this the size is treated as unknown.
const MAX_HEADER_SCAN_BYTES = 256 * 1024;

class Base64Reader {
  readonly length: number;

  constructor(private readonly b64: string) {
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    this.length = Math.floor((b64.length / 4) * 3) - padding;
  }

  /** `count` bytes from `offset`, or null past the end. */
  bytes(offset: number, count: number): Uint8Array | null {
    if (offset < 0 || count < 0 || offset + count > this.length) return null;
    const start = Math.floor(offset / 3) * 4;
    const end = Math.ceil((offset + count) / 3) * 4;
    const window = Buffer.from(this.b64.slice(start, end), 'base64');
    const skip = offset % 3;
    return window.subarray(skip, skip + count);
  }

  u8(offset: number): number | null {
    const b = this.bytes(offset, 1);
    return b ? b[0] : null;
  }

  u16be(offset: number): number | null {
    const b = this.bytes(offset, 2);
    return b ? (b[0] << 8) | b[1] : null;
  }

  u16le(offset: number): number | null {
    const b = this.bytes(offset, 2);
    return b ? b[0] | (b[1] << 8) : null;
  }

  u24le(offset: number): number | null {
    const b = this.bytes(offset, 3);
    return b ? b[0] | (b[1] << 8) | (b[2] << 16) : null;
  }

  u32be(offset: number): number | null {
    const b = this.bytes(offset, 4);
    return b ? ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 : null;
  }

  ascii(offset: number, count: number): string | null {
    const b = this.bytes(offset, count);
    return b ? String.fromCharCode(...b) : null;
  }
}

function dims(width: number | null, height: number | null): RasterDimensions | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

function pngDimensions(r: Base64Reader): RasterDimensions | null {
  // Signature, then the IHDR chunk: length (4), "IHDR", width (4), height (4).
  if (r.ascii(12, 4) !== 'IHDR') return null;
  return dims(r.u32be(16), r.u32be(20));
}

function gifDimensions(r: Base64Reader): RasterDimensions | null {
  const screen = dims(r.u16le(6), r.u16le(8));
  if (!screen) return null;
  // The first frame may declare a larger size than the logical screen; the
  // decoder allocates for it, so take the larger of the two.
  const flags = r.u8(10);
  if (flags === null) return null;
  let pos = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  while (pos < MAX_HEADER_SCAN_BYTES) {
    const block = r.u8(pos);
    if (block === 0x2c) {
      const frame = dims(r.u16le(pos + 5), r.u16le(pos + 7));
      if (!frame) return null;
      return { width: Math.max(screen.width, frame.width), height: Math.max(screen.height, frame.height) };
    }
    if (block !== 0x21) return null; // trailer or garbage before the first frame
    pos += 2; // introducer + label, then data sub-blocks up to a zero-length one
    for (;;) {
      const size = r.u8(pos);
      if (size === null) return null;
      pos += 1 + size;
      if (size === 0) break;
      if (pos >= MAX_HEADER_SCAN_BYTES) return null;
    }
  }
  return null;
}

// Start-of-frame markers carry the image size (not DHT C4, JPG C8, DAC CC).
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(r: Base64Reader): RasterDimensions | null {
  let pos = 2; // after SOI
  while (pos < MAX_HEADER_SCAN_BYTES) {
    if (r.u8(pos) !== 0xff) return null;
    let marker = r.u8(pos + 1);
    while (marker === 0xff) {
      pos++;
      marker = r.u8(pos + 1);
    }
    if (marker === null) return null;
    if (JPEG_SOF.has(marker)) return dims(r.u16be(pos + 7), r.u16be(pos + 5));
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan: no frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = r.u16be(pos + 2);
    if (length === null || length < 2) return null;
    pos += 2 + length;
  }
  return null;
}

function webpDimensions(r: Base64Reader): RasterDimensions | null {
  if (r.ascii(0, 4) !== 'RIFF' || r.ascii(8, 4) !== 'WEBP') return null;
  switch (r.ascii(12, 4)) {
    case 'VP8 ': {
      // Frame tag (3 bytes) and start code 9d 01 2a, then 14-bit sizes.
      const code = r.bytes(23, 3);
      if (!code || code[0] !== 0x9d || code[1] !== 0x01 || code[2] !== 0x2a) return null;
      const w = r.u16le(26);
      const h = r.u16le(28);
      return dims(w === null ? null : w & 0x3fff, h === null ? null : h & 0x3fff);
    }
    case 'VP8L': {
      if (r.u8(20) !== 0x2f) return null;
      const b = r.bytes(21, 4);
      if (!b) return null;
      const bits = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
      return dims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    case 'VP8X': {
      const w = r.u24le(24);
      const h = r.u24le(27);
      return dims(w === null ? null : w + 1, h === null ? null : h + 1);
    }
    default:
      return null;
  }
}

/**
 * The declared pixel size of a base64-encoded PNG, JPEG, GIF or WebP image, or
 * null when the type is another one or the header cannot be read.
 */
export function rasterDimensions(mimeType: string, base64: string): RasterDimensions | null {
  const r = new Base64Reader(base64);
  switch (mimeType) {
    case 'image/png':
      return pngDimensions(r);
    case 'image/jpeg':
      return jpegDimensions(r);
    case 'image/gif':
      return gifDimensions(r);
    case 'image/webp':
      return webpDimensions(r);
    default:
      return null;
  }
}
