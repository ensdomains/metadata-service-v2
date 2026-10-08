import { describe, it, expect, vi, afterEach } from 'vitest';
import { AvatarService } from '../src/services/avatar';
import { NETWORKS } from '../src/config/networks';
import {
  toSafeImage,
  detectRasterType,
  isSafeImageType,
  MEDIA_SECURITY_HEADERS,
  MAX_SVG_LENGTH,
} from '../src/services/media-safety';

// Security regression suite for avatar/header media (WEB-1549, v1 cluster A).
//
// An ENS name's owner controls the URL, server, bytes and Content-Type behind
// its avatar and header records. Those bytes used to be served verbatim on this
// origin with the REMOTE Content-Type (text/html → arbitrary HTML). Now the
// type comes from the bytes, SVG must have an <svg> root and is sanitized, and
// every media response carries nosniff plus a sandboxing CSP. Each case pins one
// bypass class.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.from([0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0])]);
// ISO-BMFF with major brand mif1 and compatible brand avif (common AVIF encoder output).
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypmif1'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1avifmiaf')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic')]);
const JXL = Buffer.from([0xff, 0x0a, 0xfa, 0x7f]);

const HTML = '<!DOCTYPE html><html><body><script>alert(document.domain)</script><h1>login</h1></body></html>';
const EVIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">' +
  '<script>alert(2)</script>' +
  '<foreignObject><iframe srcdoc="&lt;script&gt;alert(3)&lt;/script&gt;"></iframe></foreignObject>' +
  '<a href="javascript:alert(4)"><rect width="10" height="10" style="fill:red"/></a>' +
  '<image href="https://evil.example/track.png"/>' +
  '</svg>';

describe('toSafeImage: type comes from the bytes, never from a declared type', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['gif', GIF, 'image/gif'],
    ['webp', WEBP, 'image/webp'],
    ['bmp', BMP, 'image/bmp'],
    ['avif (compatible brand)', AVIF, 'image/avif'],
    ['heic', HEIC, 'image/heic'],
    ['jxl', JXL, 'image/jxl'],
  ])('recognizes %s by signature', (_label, bytes, type) => {
    expect(detectRasterType(bytes)).toBe(type);
    const safe = toSafeImage(bytes);
    expect(safe?.mimeType).toBe(type);
    expect(safe?.buffer.equals(bytes)).toBe(true);
  });

  it.each([
    ['HTML document', Buffer.from(HTML)],
    ['HTML with leading whitespace (defeated the old magic-byte check)', Buffer.from(`\n  ${HTML}`)],
    ['HTML with a UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(HTML)])],
    ['plain text', Buffer.from('just some text')],
    ['JavaScript', Buffer.from('alert(document.cookie)')],
    ['truncated PNG signature', Buffer.from([0x89, 0x50, 0x4e])],
    ['RIFF that is not WEBP', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI ')])],
    ['empty body', Buffer.alloc(0)],
  ])('rejects %s', (_label, bytes) => {
    expect(toSafeImage(bytes)).toBeNull();
  });

  it('sanitizes an SVG document and types it from its root element', () => {
    const safe = toSafeImage(Buffer.from(EVIL_SVG));
    expect(safe?.mimeType).toBe('image/svg+xml');
    const svg = safe!.buffer.toString('utf8');
    expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('<rect width="10" height="10" style="fill:red">');
    for (const banned of ['onload', '<script', 'foreignObject', 'iframe', 'javascript:', '<a', 'evil.example']) {
      expect(svg).not.toContain(banned);
    }
  });

  it('keeps an already sanitized SVG as it is', () => {
    const once = toSafeImage(Buffer.from(EVIL_SVG))!.buffer;
    expect(toSafeImage(once)!.buffer.equals(once)).toBe(true);
  });

  it('rejects an SVG longer than MAX_SVG_LENGTH instead of serving it unsanitized', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svg = (bytes: number) => {
      const head = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><desc>';
      const tail = '</desc></svg>';
      return Buffer.from(head + 'x'.repeat(bytes - head.length - tail.length) + tail);
    };
    const atLimit = toSafeImage(svg(MAX_SVG_LENGTH));
    expect(atLimit?.mimeType).toBe('image/svg+xml');
    expect(atLimit!.buffer.toString('utf8')).not.toContain('onload');
    expect(toSafeImage(svg(MAX_SVG_LENGTH + 1))).toBeNull();
    expect(warn).toHaveBeenCalledWith(`Rejected an SVG of ${MAX_SVG_LENGTH + 1} bytes (max ${MAX_SVG_LENGTH})`);
  });

  it('rejects an SVG the sanitizer leaves nothing of (nested past its depth limit)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(300)}${'</g>'.repeat(300)}</svg>`;
    expect(toSafeImage(Buffer.from(deep))).toBeNull();
  });

  it.each([
    ['an XML declaration, a comment and whitespace', `\uFEFF\n<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator -->\n${EVIL_SVG}`],
    ['an svg DOCTYPE with an internal subset', `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>\n<svg xmlns="&ns_svg;"/>`],
    ['a self-closing root', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ])('recognizes SVG after %s', (_label, svg) => {
    expect(toSafeImage(Buffer.from(svg))?.mimeType).toBe('image/svg+xml');
  });

  it.each([
    ['an HTML DOCTYPE before an svg element', '<!DOCTYPE html><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['an <html> root', '<html><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>'],
    ['HTML after an XML declaration', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'],
    ['an unterminated comment', '<!-- <svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an unterminated processing instruction', '<?xml version="1.0" <svg/>'],
    ['a namespaced or differently cased root', '<SVG xmlns="http://www.w3.org/2000/svg"/>'],
    ['an element that merely starts with svg', '<svgx/>'],
  ])('rejects %s', (_label, text) => {
    expect(toSafeImage(Buffer.from(text))).toBeNull();
  });

  it('isSafeImageType accepts only exact allowlisted types (no parameters, no injection)', () => {
    expect(isSafeImageType('image/png')).toBe(true);
    expect(isSafeImageType('image/svg+xml')).toBe(true);
    expect(isSafeImageType('text/html')).toBe(false);
    expect(isSafeImageType('image/png; charset=utf-8')).toBe(false);
    expect(isSafeImageType('image/png" onload="alert(1)')).toBe(false);
    expect(isSafeImageType(undefined)).toBe(false);
  });
});

// Drive the real AvatarService with a fake resolver (the record's resolved URI)
// and a stubbed global fetch (the name owner's server).
function serviceResolvingTo(uri: string): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain);
  (svc as unknown as { resolver: unknown }).resolver = { getAvatar: vi.fn().mockResolvedValue(uri), getHeader: vi.fn().mockResolvedValue(uri) };
  (svc as unknown as { legacyResolver?: unknown }).legacyResolver = undefined;
  return svc;
}

function remoteServes(body: Uint8Array | string, contentType: string) {
  const fetchMock = vi.fn(async () => new Response(body as unknown as BodyInit, { status: 200, headers: { 'Content-Type': contentType } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AvatarService media: remote and data: URIs go through the allowlist', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('remote text/html is rejected (was served as text/html on our origin)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    remoteServes(`\n${HTML}`, 'text/html; charset=utf-8');
    expect(await serviceResolvingTo('https://attacker.example/a').getAvatarImage('evil.eth')).toBeNull();
  });

  it('remote HTML labelled with an image Content-Type is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    remoteServes(HTML, 'image/png');
    expect(await serviceResolvingTo('https://attacker.example/a.png').getHeaderImage('evil.eth')).toBeNull();
  });

  it('a Content-Type crafted to break out of an attribute never becomes the type', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    remoteServes(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'image/png" onload="alert(1)');
    expect(await serviceResolvingTo('https://attacker.example/x').getAvatarImage('evil.eth')).toBeNull();
  });

  it('real image bytes get their own type even when the server lies', async () => {
    remoteServes(PNG, 'text/html');
    const img = await serviceResolvingTo('https://cdn.example/a').getAvatarImage('ok.eth');
    expect(img?.mimeType).toBe('image/png');
    expect(Buffer.compare(img!.buffer, PNG)).toBe(0);
  });

  it('remote SVG is typed from its root element, whatever the server claims', async () => {
    remoteServes(EVIL_SVG, 'text/html');
    const img = await serviceResolvingTo('https://attacker.example/a.svg').getAvatarImage('evil.eth');
    expect(img?.mimeType).toBe('image/svg+xml');
    expect(img!.buffer.toString('utf8')).not.toMatch(/onload|<script|javascript:|evil\.example/);
  });

  // A real resolver with only its chain lookup stubbed: an inline SVG record goes
  // through ens-avatar's own length check (maxSvgLength), then toSafeImage.
  function serviceWithInlineRecord(record: string): AvatarService {
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain);
    const client = (svc as unknown as { resolver: { client: { getEnsRecord: unknown } } }).resolver.client;
    client.getEnsRecord = vi.fn().mockResolvedValue({ record, address: undefined });
    return svc;
  }
  const inlineSvg = (text: string) => `<svg xmlns="http://www.w3.org/2000/svg"><desc>${text}</desc></svg>`;

  it('serves an inline SVG longer than the library default (256 KiB), up to MAX_SVG_LENGTH', async () => {
    const img = await serviceWithInlineRecord(inlineSvg('x'.repeat(512 * 1024))).getAvatarImage('inline.eth');
    expect(img?.mimeType).toBe('image/svg+xml');
  });

  it('rejects an inline SVG over MAX_SVG_LENGTH, counted in characters or in UTF-8 bytes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await serviceWithInlineRecord(inlineSvg('x'.repeat(MAX_SVG_LENGTH))).getAvatarImage('inline.eth')).toBeNull();
    // 400k CJK characters: within the library's limit (UTF-16 code units), but
    // 1.2 MB of UTF-8, which toSafeImage rejects.
    expect(await serviceWithInlineRecord(inlineSvg('中'.repeat(400_000))).getAvatarImage('inline.eth')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`bytes (max ${MAX_SVG_LENGTH})`));
  });

  it('a base64 data-URI SVG is typed from its bytes', async () => {
    const uri = `data:image/svg+xml;base64,${Buffer.from(EVIL_SVG).toString('base64')}`;
    const img = await serviceResolvingTo(uri).getAvatarImage('evil.eth');
    expect(img?.mimeType).toBe('image/svg+xml');
  });

  it('a data URI declaring image/svg+xml but carrying HTML is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uri = `data:image/svg+xml;base64,${Buffer.from(HTML).toString('base64')}`;
    expect(await serviceResolvingTo(uri).getAvatarImage('evil.eth')).toBeNull();
  });

  it('a data URI declaring image/png but carrying HTML is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uri = `data:image/png;base64,${Buffer.from(HTML).toString('base64')}`;
    expect(await serviceResolvingTo(uri).getAvatarImage('evil.eth')).toBeNull();
  });

  it('a genuine data-URI PNG is kept', async () => {
    const uri = `data:image/png;base64,${PNG.toString('base64')}`;
    const img = await serviceResolvingTo(uri).getAvatarImage('ok.eth');
    expect(img?.mimeType).toBe('image/png');
  });
});

describe('MEDIA_SECURITY_HEADERS', () => {
  it('disables MIME sniffing and script in directly-opened media', () => {
    expect(MEDIA_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    const csp = MEDIA_SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toMatch(/script-src/);
  });
});
