import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageGenerationService, MAX_RASTERIZED_AVATAR_PIXELS, maxRasterizedAvatarPixels } from '../src/services/image';
import { MAX_HEADER_SCAN_BYTES, rasterDimensions } from '../src/services/raster-dimensions';

// resvg (the /rasterize route) decodes a raster avatar to its full declared
// size in WebAssembly memory, which never shrinks for the life of the isolate:
// a 61 KiB all-zero PNG declaring 8000x8000 pixels took ~0.4 GB against a
// 128 MB isolate limit, and decoding needs several times the bitmap (a
// progressive JPEG at 2048x2048 took 66 MB). A raster avatar is rasterized only
// when it is a PNG, JPEG or GIF of at most 6 MiB of base64 whose header declares
// at most its format's pixel cap (measured, see MAX_RASTERIZED_AVATAR_PIXELS):
// PNG 1200x1200, baseline JPEG 2048x2048, any other JPEG 1536x1536, GIF
// 1344x1344. Otherwise, or when the size cannot be read within the scanned
// window, the card is rasterized on its no-avatar background.

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

// SOI, an APPn segment of `pad` bytes (EXIF/ICC sit here), then SOF0.
function jpeg(width: number, height: number, pad = 16, sof = 0xc0): Buffer {
  const app = Buffer.alloc(4 + pad);
  app.writeUInt16BE(0xffe1, 0);
  app.writeUInt16BE(pad + 2, 2);
  const frame = Buffer.from([0xff, sof, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame, Buffer.alloc(9), Buffer.from([0xff, 0xd9])]);
}

// Logical screen, a graphic control extension, then the first frame.
function gif(screenW: number, screenH: number, frameW = screenW, frameH = screenH): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(screenW, 6);
  b.writeUInt16LE(screenH, 8);
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(frameW, 5);
  desc.writeUInt16LE(frameH, 7);
  return Buffer.concat([b, gce, desc, Buffer.from([0x02, 0x00, 0x3b])]);
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(24, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(kind, 12, 'ascii');
  b.writeUInt32LE(10, 16);
  if (kind === 'VP8 ') {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  }
  return b;
}

const b64 = (buf: Buffer) => buf.toString('base64');

describe('rasterDimensions reads the declared size from the header', () => {
  it.each([
    ['image/png', png(640, 480), { width: 640, height: 480 }],
    ['image/png', png(8000, 8000), { width: 8000, height: 8000 }],
    ['image/jpeg', jpeg(1200, 900), { width: 1200, height: 900, progressive: false }],
    ['image/jpeg (extended sequential)', jpeg(1200, 900, 16, 0xc1), { width: 1200, height: 900, progressive: false }],
    ['image/jpeg (progressive, after a 60 KiB APP segment)', jpeg(5000, 4000, 60 * 1024, 0xc2), { width: 5000, height: 4000, progressive: true }],
    ['image/jpeg (lossless, decoded like neither: the progressive cap)', jpeg(640, 480, 16, 0xc3), { width: 640, height: 480, progressive: true }],
    ['image/gif', gif(300, 200), { width: 300, height: 200 }],
    ['image/gif (first frame larger than the screen)', gif(10, 10, 9000, 9000), { width: 9000, height: 9000 }],
    ['image/jpeg (fill bytes before the frame marker)', Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100, 0xff), jpeg(640, 480).subarray(2)]), { width: 640, height: 480, progressive: false }],
  ])('%s', (label, bytes, expected) => {
    const type = label.split(' ')[0];
    expect(rasterDimensions(type, b64(bytes))).toEqual(expected);
  });

  it('returns null for truncated or malformed headers and other types', () => {
    expect(rasterDimensions('image/png', b64(png(10, 10).subarray(0, 20)))).toBeNull();
    expect(rasterDimensions('image/png', b64(png(0, 10)))).toBeNull();
    expect(rasterDimensions('image/jpeg', b64(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])))).toBeNull();
    expect(rasterDimensions('image/gif', b64(Buffer.from('GIF89a')))).toBeNull();
    // resvg cannot decode WebP, so its size is not read.
    expect(rasterDimensions('image/webp', b64(webp('VP8X', 100, 100)))).toBeNull();
    expect(rasterDimensions('image/avif', b64(png(10, 10)))).toBeNull();
  });

  it('reads no further than MAX_HEADER_SCAN_BYTES, and a large payload costs no more than a small one', () => {
    // A JPEG whose frame header sits after a fill-byte run longer than the window.
    const sof = jpeg(16, 16).subarray(2);
    const pastWindow = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(MAX_HEADER_SCAN_BYTES, 0xff), sof]);
    expect(rasterDimensions('image/jpeg', b64(pastWindow))).toBeNull();

    // 25 MB of fill bytes (the default avatar size cap) is scanned in the same window.
    const huge = b64(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(25 * 1024 * 1024, 0xff), sof]));
    const start = performance.now();
    expect(rasterDimensions('image/jpeg', huge)).toBeNull();
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('maxRasterizedAvatarPixels', () => {
  it('gives each format its cap, and a JPEG of unknown frame type the lower one', () => {
    expect(maxRasterizedAvatarPixels('image/png', { width: 1, height: 1 })).toBe(MAX_RASTERIZED_AVATAR_PIXELS.png);
    expect(maxRasterizedAvatarPixels('image/gif', { width: 1, height: 1 })).toBe(MAX_RASTERIZED_AVATAR_PIXELS.gif);
    expect(maxRasterizedAvatarPixels('image/jpeg', { width: 1, height: 1, progressive: false })).toBe(MAX_RASTERIZED_AVATAR_PIXELS.jpeg);
    expect(maxRasterizedAvatarPixels('image/jpeg', { width: 1, height: 1, progressive: true })).toBe(MAX_RASTERIZED_AVATAR_PIXELS.progressiveJpeg);
    expect(maxRasterizedAvatarPixels('image/jpeg', { width: 1, height: 1 })).toBe(MAX_RASTERIZED_AVATAR_PIXELS.progressiveJpeg);
  });
});

describe('forRasterization keeps only raster avatars within the pixel cap', () => {
  const svc = new ImageGenerationService();
  const card = async (bytes: Buffer, type: string) =>
    (await svc.generateDomainImage({ name: 'nick.eth', avatarBase64: b64(bytes), avatarMimeType: type })).svg;
  const noAvatar = async () => (await svc.generateDomainImage({ name: 'nick.eth' })).svg;
  const collapse = (svg: string) => svg.replace(/>\s+</g, '><').trim();

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each([
    ['image/png', png(1200, 1200), 'PNG at the cap'],
    ['image/png', png(1080, 1080), 'the common 1080px PNG'],
    ['image/png', png(1440, 1000), 'a non-square PNG of the same pixel count'],
    ['image/jpeg', jpeg(2048, 2048, 60 * 1024), 'baseline JPEG at the cap'],
    ['image/jpeg', jpeg(2048, 2048, 16, 0xc1), 'extended sequential JPEG at the baseline cap'],
    ['image/jpeg', jpeg(1536, 1536, 60 * 1024, 0xc2), 'progressive JPEG at its cap'],
    ['image/jpeg', jpeg(800, 1300), 'a small JPEG'],
    ['image/gif', gif(1344, 1344), 'GIF at the cap'],
    ['image/gif', gif(500, 500), 'a small GIF'],
  ])('keeps a %s avatar within its format cap (%#: %s)', async (type, bytes) => {
    const withAvatar = await card(bytes, type);
    expect(svc.forRasterization(withAvatar, 'nick.eth')).toBe(withAvatar);
  });

  it.each([
    ['image/png', png(8000, 8000)],
    ['image/png', png(1201, 1200)],
    ['image/png', png(1441, 1000)],
    ['image/png', png(2048, 2048)],
    ['image/jpeg', jpeg(2049, 2048)],
    ['image/jpeg', jpeg(1537, 1536, 16, 0xc2)],
    ['image/jpeg', jpeg(1600, 1600, 16, 0xc3)],
    ['image/jpeg', jpeg(5000, 5000, 1024)],
    ['image/gif', gif(1345, 1344)],
    ['image/gif', gif(10, 10, 9000, 9000)],
  ])('replaces a %s avatar over the cap with the no-avatar background', async (type, bytes) => {
    const out = svc.forRasterization(await card(bytes, type), 'nick.eth');
    expect(out).not.toContain('data:');
    expect(collapse(out)).toBe(collapse(await noAvatar()));
  });

  it('replaces a raster avatar whose size cannot be read, and types resvg does not decode', async () => {
    for (const [type, bytes] of [
      ['image/png', png(10, 10).subarray(0, 20)],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])],
      ['image/avif', png(10, 10)],
      ['image/bmp', png(10, 10)],
      ['image/webp', webp('VP8X', 100, 100)],
    ] as const) {
      const out = svc.forRasterization(await card(Buffer.from(bytes), type), 'nick.eth');
      expect(out).not.toContain('data:');
    }
  });

  it('replaces a small-declared raster avatar whose payload is over the byte budget', async () => {
    // 16x16 declared, padded with ~4.6 MB of trailing data: over 6 MiB of base64.
    const padded = Buffer.concat([png(16, 16), Buffer.alloc(4.6 * 1024 * 1024)]);
    const out = svc.forRasterization(await card(padded, 'image/png'), 'nick.eth');
    expect(out).not.toContain('data:');
  });

  it('replaces a composer-shaped avatar element of any other type (resvg renders SVG from data:text/plain too)', () => {
    const svgPayload = b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const odd = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/plain;base64,${svgPayload}" width="518" height="518"/></svg>`;
    const out = svc.forRasterization(odd, 'nick.eth');
    expect(out).not.toContain('data:');
    expect(out).toContain('<rect width="518" height="518"');
  });

  it('stays linear on long whitespace runs after href= (text or attribute), and ignores text', () => {
    const run = ' '.repeat(100_000);
    for (const svg of [
      `<svg xmlns="http://www.w3.org/2000/svg"><text>href=${run}x.eth</text></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><text aria-label="href=${run}"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><text>href="data:x.eth</text></svg>`,
    ]) {
      const start = performance.now();
      expect(svc.forRasterization(svg, 'nick.eth')).toBe(svg);
      expect(performance.now() - start).toBeLessThan(100);
    }
  });

  it('fails closed on a data: URI in any other markup', () => {
    const svgPayload = b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    for (const element of [
      `<image href="data:;base64,${svgPayload}" width="518" height="518"/>`,
      `<image xlink:href='data:text/plain;base64,${svgPayload}' width="518" height="518"/>`,
      `<image href="DATA:image/png;base64,${b64(png(10, 10))}" width="518" height="518"/>`,
      `<image width="518" height="518" href="data:image/png;base64,${b64(png(10, 10))}"/>`,
    ]) {
      const odd = `<svg xmlns="http://www.w3.org/2000/svg">${element}</svg>`;
      expect(() => svc.forRasterization(odd, 'nick.eth')).toThrow(/unexpected embedded data URI/);
    }
  });
});
