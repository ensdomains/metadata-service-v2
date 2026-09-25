// Pixel dimensions of a raster image, read from its header without decoding
// the pixels, for the formats resvg decodes when rasterizing the NFT card
// (PNG, JPEG, GIF; this resvg build has no WebP decoder). resvg allocates the
// full decoded bitmap, so the declared size (not the file size) is what a
// render costs: a 61 KiB all-zero PNG declaring 8000x8000 pixels takes ~0.4 GB.
// Only the first MAX_HEADER_SCAN_BYTES of the base64 payload are decoded, once,
// and every read stays inside that window, so a large avatar costs no more to
// scan than a small one.

export interface RasterDimensions {
  width: number;
  height: number;
}

// How far into the file a header may be (JPEG can carry EXIF/ICC segments
// before its frame header). Past this the size is treated as unknown.
export const MAX_HEADER_SCAN_BYTES = 256 * 1024;

class HeaderWindow {
  private readonly bytes: Buffer;

  constructor(base64: string) {
    // Four base64 characters are three bytes: a window that starts at 0 and
    // ends on a multiple of four decodes exactly the first bytes of the file.
    this.bytes = Buffer.from(base64.slice(0, Math.ceil(MAX_HEADER_SCAN_BYTES / 3) * 4), 'base64');
  }

  get length(): number {
    return this.bytes.length;
  }

  u8(offset: number): number | null {
    return offset >= 0 && offset < this.bytes.length ? this.bytes[offset] : null;
  }

  u16be(offset: number): number | null {
    return offset >= 0 && offset + 2 <= this.bytes.length ? this.bytes.readUInt16BE(offset) : null;
  }

  u16le(offset: number): number | null {
    return offset >= 0 && offset + 2 <= this.bytes.length ? this.bytes.readUInt16LE(offset) : null;
  }

  u32be(offset: number): number | null {
    return offset >= 0 && offset + 4 <= this.bytes.length ? this.bytes.readUInt32BE(offset) : null;
  }

  ascii(offset: number, count: number): string | null {
    return offset >= 0 && offset + count <= this.bytes.length
      ? this.bytes.toString('latin1', offset, offset + count)
      : null;
  }
}

function dims(width: number | null, height: number | null): RasterDimensions | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

function pngDimensions(r: HeaderWindow): RasterDimensions | null {
  // Signature, then the IHDR chunk: length (4), "IHDR", width (4), height (4).
  if (r.ascii(12, 4) !== 'IHDR') return null;
  return dims(r.u32be(16), r.u32be(20));
}

function gifDimensions(r: HeaderWindow): RasterDimensions | null {
  const screen = dims(r.u16le(6), r.u16le(8));
  if (!screen) return null;
  // The first frame may declare a larger size than the logical screen; the
  // decoder allocates for it, so take the larger of the two.
  const flags = r.u8(10);
  if (flags === null) return null;
  let pos = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  while (pos < r.length) {
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
    }
  }
  return null;
}

// Start-of-frame markers carry the image size (not DHT C4, JPG C8, DAC CC).
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(r: HeaderWindow): RasterDimensions | null {
  let pos = 2; // after SOI
  while (pos < r.length) {
    if (r.u8(pos) !== 0xff) return null;
    // Fill bytes (runs of 0xFF) may precede a marker; u8 is null past the window.
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

/**
 * The declared pixel size of a base64-encoded PNG, JPEG or GIF image, or null
 * when the type is another one or the header cannot be read within the first
 * MAX_HEADER_SCAN_BYTES.
 */
export function rasterDimensions(mimeType: string, base64: string): RasterDimensions | null {
  switch (mimeType) {
    case 'image/png':
      return pngDimensions(new HeaderWindow(base64));
    case 'image/jpeg':
      return jpegDimensions(new HeaderWindow(base64));
    case 'image/gif':
      return gifDimensions(new HeaderWindow(base64));
    default:
      return null;
  }
}
