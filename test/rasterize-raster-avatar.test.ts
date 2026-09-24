import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageGenerationService } from '../src/services/image';
import { rasterDimensions } from '../src/services/raster-dimensions';

// resvg (the /rasterize route) decodes a raster avatar to its full declared
// size in WebAssembly memory, which never shrinks for the life of the isolate:
// a 61 KiB all-zero PNG declaring 8000x8000 pixels took ~0.4 GB against a
// 128 MB isolate limit. A raster avatar is rasterized only when its header
// declares at most 2048x2048 pixels; otherwise, or when the size cannot be
// read, the card is rasterized on its no-avatar background.

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
    ['image/jpeg', jpeg(1200, 900), { width: 1200, height: 900 }],
    ['image/jpeg (progressive, after a 60 KiB APP segment)', jpeg(5000, 4000, 60 * 1024, 0xc2), { width: 5000, height: 4000 }],
    ['image/gif', gif(300, 200), { width: 300, height: 200 }],
    ['image/gif (first frame larger than the screen)', gif(10, 10, 9000, 9000), { width: 9000, height: 9000 }],
    ['image/webp (VP8)', webp('VP8 ', 800, 600), { width: 800, height: 600 }],
    ['image/webp (VP8L)', webp('VP8L', 1024, 768), { width: 1024, height: 768 }],
    ['image/webp (VP8X)', webp('VP8X', 3000, 3000), { width: 3000, height: 3000 }],
  ])('%s', (label, bytes, expected) => {
    const type = label.split(' ')[0];
    expect(rasterDimensions(type, b64(bytes))).toEqual(expected);
  });

  it('returns null for truncated or malformed headers and other types', () => {
    expect(rasterDimensions('image/png', b64(png(10, 10).subarray(0, 20)))).toBeNull();
    expect(rasterDimensions('image/png', b64(png(0, 10)))).toBeNull();
    expect(rasterDimensions('image/jpeg', b64(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])))).toBeNull();
    expect(rasterDimensions('image/gif', b64(Buffer.from('GIF89a')))).toBeNull();
    expect(rasterDimensions('image/webp', b64(Buffer.from('RIFF\0\0\0\0WEBPVP8Z')))).toBeNull();
    expect(rasterDimensions('image/avif', b64(png(10, 10)))).toBeNull();
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
    ['image/png', png(2048, 2048)],
    ['image/jpeg', jpeg(1500, 1500)],
    ['image/gif', gif(500, 500)],
    ['image/webp', webp('VP8X', 1024, 4096)],
  ])('keeps a %s avatar at or under 2048x2048 pixels', async (type, bytes) => {
    const withAvatar = await card(bytes, type);
    expect(svc.forRasterization(withAvatar, 'nick.eth')).toBe(withAvatar);
  });

  it.each([
    ['image/png', png(8000, 8000)],
    ['image/png', png(2049, 2048)],
    ['image/jpeg', jpeg(5000, 5000, 1024)],
    ['image/gif', gif(10, 10, 9000, 9000)],
    ['image/webp', webp('VP8X', 3000, 3000)],
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
    ] as const) {
      const out = svc.forRasterization(await card(Buffer.from(bytes), type), 'nick.eth');
      expect(out).not.toContain('data:');
    }
  });

  it('replaces a composer-shaped avatar element of any other type (resvg renders SVG from data:text/plain too)', () => {
    const svgPayload = b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const odd = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/plain;base64,${svgPayload}" width="518" height="518"/></svg>`;
    const out = svc.forRasterization(odd, 'nick.eth');
    expect(out).not.toContain('data:');
    expect(out).toContain('<rect width="518" height="518"');
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
