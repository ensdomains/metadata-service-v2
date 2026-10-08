import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mediaView } from '../src/middleware/media-view';

// The page a browser tab gets for an image endpoint: the image drawn with <img>
// next to the endpoint's documentation. Every request value on it is escaped.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const app = new Hono();
app.use('*', mediaView);
app.get('*', () => new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } }));

const open = async (path: string) => (await app.request(path, { headers: { 'Sec-Fetch-Dest': 'document' } })).text();

describe('the avatar and header pages', () => {
  it('document the avatar route with this request\'s values', async () => {
    const html = await open('/mainnet/avatar/nick.eth');
    expect(html).toContain('<title>nick.eth · Avatar · ENS Metadata</title>');
    expect(html).toContain('<img src="/mainnet/avatar/nick.eth" alt="nick.eth">');
    expect(html).toContain('<pre><code>GET /{network}/avatar/{name}</code></pre>');
    expect(html).toContain('<dt><code>network</code><code class="value">mainnet</code></dt>');
    expect(html).toContain('<dt><code>name</code><code class="value">nick.eth</code></dt>');
    expect(html).toContain('<dt><code>200</code></dt><dd><code>image/png</code> <code>Cache-Control: public, max-age=3600</code></dd>');
    expect(html).toContain('<dt><code>404</code></dt>');
    expect(html).not.toContain('Query parameters');
    expect(html).toContain('<a href="/mainnet/avatar/nick.eth/meta">Avatar metadata (JSON)</a>');
    expect(html).toContain('<a href="/mainnet/header/nick.eth">Header</a>');
    expect(html).toContain('<a href="/mainnet/registry/nick.eth/image">NFT card</a>');
  });

  it('document the header route, which has no metadata route', async () => {
    const html = await open('/sepolia/header/nick.eth');
    expect(html).toContain('<pre><code>GET /{network}/header/{name}</code></pre>');
    expect(html).toContain('<code class="value">sepolia</code>');
    expect(html).not.toContain('/meta');
    expect(html).toContain('<a href="/sepolia/avatar/nick.eth">Avatar</a>');
  });

  it('list the responses in status order', async () => {
    const html = await open('/mainnet/avatar/nick.eth');
    const statuses = [...html.matchAll(/<dt><code>(\d{3})<\/code><\/dt>/g)].map((m) => Number(m[1]));
    expect(statuses).toEqual([200, 400, 404, 429, 503, 504]);
  });
});

describe('the NFT card pages', () => {
  it('document the image route with the query this request used', async () => {
    const html = await open('/mainnet/registry/nick.eth/image?w=500&h=400&status=migrated');
    expect(html).toContain('<title>nick.eth · NFT card · ENS Metadata</title>');
    expect(html).toContain('<img src="/mainnet/registry/nick.eth/image?w=500&#38;h=400&#38;status=migrated" alt="nick.eth">');
    expect(html).toContain('<pre><code>GET /{network}/{registryType}/{identifier}/image</code></pre>');
    expect(html).toContain('<dt><code>registryType</code><code class="value">registry</code></dt>');
    expect(html).toContain('<dt><code>w, h</code><code class="value">500 × 400</code></dt>');
    expect(html).toContain('<dt><code>status</code><code class="value">migrated</code></dt>');
    expect(html).toContain('<dt><code>410</code></dt>');
    expect(html).toContain('<a href="/mainnet/registry/nick.eth/rasterize?w=500&#38;h=400&#38;status=migrated">NFT card · PNG</a>');
    expect(html).toContain('<a href="/mainnet/registry/nick.eth">Metadata (JSON)</a>');
  });

  it('document the rasterize route of a v1 contract and token id', async () => {
    const html = await open('/mainnet/0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85/42/rasterize');
    expect(html).toContain('<title>42 · NFT card · PNG · ENS Metadata</title>');
    expect(html).toContain('<code class="value">0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85</code>');
    expect(html).toContain('<dt><code>w, h</code></dt>'); // no size in this request
    expect(html).toContain('<a href="/mainnet/0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85/42/image">NFT card · SVG</a>');
  });

  it('show a single size parameter as given', async () => {
    const html = await open('/mainnet/registry/nick.eth/image?w=500');
    expect(html).toContain('<code class="value">500 × –</code>');
  });
});

describe('every request value on the page is escaped', () => {
  it('in a name, its decoded form and the paths built from it', async () => {
    // The URL parser percent-encodes " < > in the path but keeps ', and the
    // page shows the name decoded.
    const html = await open(`/mainnet/avatar/a'b%22c%3Cimg%20src=x%20onerror=alert(1)%3E`);
    expect(html).toContain('<h1>a&#39;b&#34;c&#60;img src=x onerror=alert(1)&#62;</h1>');
    expect(html).toContain('<a href="/mainnet/avatar/a&#39;b%22c%3Cimg%20src=x%20onerror=alert(1)%3E/meta">');
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).not.toContain('<script');
  });

  it('in the query', async () => {
    const html = await open(`/mainnet/registry/nick.eth/image?status=%3Cb%3E'`);
    expect(html).toContain('<code class="value">&#60;b&#62;&#39;</code>');
  });

  it('in an image route this page does not document', async () => {
    const html = await open(`/x/y'%3Cz%3E`);
    expect(html).toContain(`<title>/x/y&#39;&#60;z&#62; · ENS Metadata</title>`);
    expect(html).toContain(`<img src="/x/y&#39;%3Cz%3E" alt="/x/y&#39;&#60;z&#62;">`);
    expect(html).not.toContain('<h2>Endpoint</h2>');
  });

  it('in a path with malformed percent-encoding, shown as requested', async () => {
    const html = await open('/mainnet/avatar/a%E0%A4%A');
    expect(html).toContain('<h1>a%E0%A4%A</h1>');
  });
});

describe('the image', () => {
  it('draws SVG at the width of its panel, raster images at their own size', async () => {
    const svg = new Hono();
    svg.use('*', mediaView);
    svg.get('*', () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
    const page = await (await svg.request('/mainnet/avatar/nick.eth', { headers: { 'Sec-Fetch-Dest': 'document' } })).text();
    expect(page).toContain('<img src="/mainnet/avatar/nick.eth" alt="nick.eth" class="vector">');
    expect(await open('/mainnet/avatar/nick.eth')).toContain('<img src="/mainnet/avatar/nick.eth" alt="nick.eth">');
  });
});

describe('requests that are not a browser tab', () => {
  it('a HEAD request gets the media headers, not the page', async () => {
    const res = await app.request('/a', { method: 'HEAD', headers: { 'Sec-Fetch-Dest': 'document' } });
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });
});
