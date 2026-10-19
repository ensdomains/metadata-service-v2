import type { Context, Next } from 'hono';
import { isMediaResponse } from './security-headers';

// Media opened in a browser tab (a top-level navigation, Sec-Fetch-Dest:
// document) is shown on a page of this service that draws it with <img> next to
// the endpoint's documentation, as the v1 service did. A browser runs no script,
// follows no link and loads nothing from an image drawn by <img>, whatever its
// bytes, and the tab shows this page instead of a document the name's owner
// wrote. The page loads the same URL as an image (an edge-cache hit after this
// request) and holds nothing else the owner controls: every request value it
// shows is escaped. Everything else gets the media itself: <img>, iframes, API
// clients, and browsers that send no Fetch Metadata, which still get the
// sandboxing CSP and, for SVG, the sanitized document.

export const MEDIA_VIEW_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed percent-encoding: show it as requested
  }
}

// The documentation of the endpoint a page shows. `doc`, `summary` and the
// error texts are this file's own markup; request values (`value`, `subject`,
// the related paths) are escaped when the page is rendered.
interface Param {
  name: string;
  value?: string;
  doc: string;
}

interface Endpoint {
  title: string;
  subject: string;
  summary: string;
  route: string;
  path: Param[];
  query: Param[];
  errors: [status: number, doc: string][];
  related: [label: string, path: string][];
}

const COMMON_ERRORS: [number, string][] = [
  [400, 'Invalid network, name or parameter'],
  [429, 'Rate limited'],
  [504, 'No answer within 30 s'],
];

const byStatus = (a: [number, string], b: [number, string]) => a[0] - b[0];

const networkParam = (value: string): Param => ({
  name: 'network',
  value,
  doc: '<code>mainnet</code> or <code>sepolia</code>',
});

function describeEndpoint(url: URL): Endpoint | null {
  const segments = url.pathname.split('/').slice(1);

  if (segments.length === 3 && (segments[1] === 'avatar' || segments[1] === 'header')) {
    const [network, record, name] = segments;
    const other = record === 'avatar' ? 'header' : 'avatar';
    return {
      title: record === 'avatar' ? 'Avatar' : 'Header',
      subject: decode(name),
      summary:
        `The image in the name’s <code>${record}</code> text record: an HTTPS, IPFS, IPNS or Arweave link, ` +
        'an NFT (ERC-721 or ERC-1155), or inline data. Its type is read from its bytes, and SVG is sanitized.',
      route: `/{network}/${record}/{name}`,
      path: [networkParam(decode(network)), { name: 'name', value: decode(name), doc: 'ENS name' }],
      query: [],
      errors: (
        [
          [404, `The name has no usable <code>${record}</code> record`],
          [503, 'The lookup failed (RPC, CCIP gateway or media host); try again shortly'],
          ...COMMON_ERRORS,
        ] as [number, string][]
      ).sort(byStatus),
      related: [
        ...(record === 'avatar' ? [['Avatar metadata (JSON)', `/${network}/avatar/${name}/meta`] as [string, string]] : []),
        [other === 'avatar' ? 'Avatar' : 'Header', `/${network}/${other}/${name}`],
        ['NFT card', `/${network}/registry/${name}/image`],
      ],
    };
  }

  if (segments.length === 4 && (segments[3] === 'image' || segments[3] === 'rasterize')) {
    const [network, registry, identifier, format] = segments;
    const png = format === 'rasterize';
    const w = url.searchParams.get('w');
    const h = url.searchParams.get('h');
    return {
      title: png ? 'NFT card · PNG' : 'NFT card',
      subject: decode(identifier),
      summary: png
        ? 'The name’s NFT card, rendered to PNG by this service.'
        : 'The name’s NFT image, as SVG: the name over its avatar. Names on ENS v2 get the ENS v2 card, with their etherloom weave when they have no avatar.',
      route: `/{network}/{registryType}/{identifier}/${format}`,
      path: [
        networkParam(decode(network)),
        {
          name: 'registryType',
          value: decode(registry),
          doc: '<code>registry</code>, <code>namewrapper</code>, or a contract address: the v1 BaseRegistrar or NameWrapper, or a v2 registry',
        },
        {
          name: 'identifier',
          value: decode(identifier),
          doc: 'ENS name, or the contract’s token id (decimal or <code>0x</code> hex)',
        },
      ],
      query: [
        {
          name: 'w, h',
          value: w === null && h === null ? undefined : `${w ?? '–'} × ${h ?? '–'}`,
          doc: png
            ? 'Output size in px, used when both are 100–2000. Default 518 × 518'
            : 'Size in px: both, each 100–2000. Default 518 × 518',
        },
        {
          name: 'status',
          value: url.searchParams.get('status') ?? undefined,
          doc: '<code>unmigrated</code>, <code>migrated</code> or <code>native</code>: the card to draw (<code>migrated</code> and <code>native</code> get the ENS v2 card). The name must still exist',
        },
      ],
      errors: (
        [
          [404, 'Unknown name or token'],
          [410, 'The name has expired'],
          [503, 'An indexer or RPC was unreachable'],
          ...COMMON_ERRORS,
        ] as [number, string][]
      ).sort(byStatus),
      related: [
        [png ? 'NFT card · SVG' : 'NFT card · PNG', `/${network}/${registry}/${identifier}/${png ? 'image' : 'rasterize'}${url.search}`],
        ['Metadata (JSON)', `/${network}/${registry}/${identifier}`],
      ],
    };
  }

  return null;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--panel:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--code:#f1f1f3;--accent:#3889ff;--check:#f0f0f2}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--panel:#131316;--fg:#f4f4f5;--muted:#a1a1aa;--line:#26262b;--code:#1c1c21;--accent:#6aa6ff;--check:#18181c}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
header,main,footer{max-width:1120px;margin:0 auto;padding-inline:24px}
header{padding-block:20px;font-size:14px;font-weight:600}
main{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:48px;align-items:start;padding-block:12px 40px}
figure{position:sticky;top:24px;display:grid;place-items:center;min-height:280px;margin:0;padding:24px;border:1px solid var(--line);border-radius:16px;background:var(--panel) repeating-conic-gradient(var(--check) 0 25%,transparent 0 50%) 0 0/24px 24px}
figure img{display:block;max-width:100%;max-height:70vh;border-radius:8px}
/* An SVG sized only by its viewBox would be drawn at 300 x 150 */
.vector{width:100%;height:auto}
.kicker{margin:0 0 4px;color:var(--accent);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0 0 8px;font-size:28px;line-height:1.25;letter-spacing:-.02em;overflow-wrap:anywhere}
.summary{margin:0;color:var(--muted)}
h2{margin:32px 0 10px;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{margin:0;padding:12px 14px;border-radius:10px;background:var(--code);white-space:pre-wrap;overflow-wrap:anywhere}
.summary code,dd code{padding:1px 5px;border-radius:5px;background:var(--code)}
dl{margin:0}
dt{margin-top:14px}
dt:first-child{margin-top:0}
dt code:first-child{font-weight:600}
dd{margin:2px 0 0;color:var(--muted)}
.value{margin-left:8px;padding:1px 6px;border-radius:5px;background:var(--code);overflow-wrap:anywhere}
.statuses{display:grid;grid-template-columns:3rem 1fr;gap:6px 12px}
.statuses dt,.statuses dd{margin:0}
ul{margin:0;padding:0;list-style:none}
li+li{margin-top:10px}
li code{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
footer{padding-block:20px 32px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media (max-width:820px){main{grid-template-columns:1fr;gap:28px}figure{position:static;min-height:0}h1{font-size:24px}}
`;

function params(heading: string, list: Param[]): string {
  if (list.length === 0) return '';
  const rows = list.map(
    (p) =>
      `<dt><code>${p.name}</code>${p.value === undefined ? '' : `<code class="value">${escapeHtml(p.value)}</code>`}</dt><dd>${p.doc}</dd>`,
  );
  return `<h2>${heading}</h2><dl>${rows.join('')}</dl>`;
}

function renderPage(url: URL, media: Response): string {
  const endpoint = describeEndpoint(url);
  const subject = escapeHtml(endpoint?.subject ?? decode(url.pathname));
  const type = media.headers.get('Content-Type') ?? '';
  const cache = media.headers.get('Cache-Control');
  const statuses: [number, string][] = [
    [200, `<code>${escapeHtml(type)}</code>${cache ? ` <code>Cache-Control: ${escapeHtml(cache)}</code>` : ''}`],
    ...(endpoint?.errors ?? []),
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject}${endpoint ? ` · ${endpoint.title}` : ''} · ENS Metadata</title>
<style>${STYLE}</style>
</head>
<body>
<header>ENS Metadata Service</header>
<main>
<figure><img src="${escapeHtml(url.pathname + url.search)}" alt="${subject}"${type.startsWith('image/svg+xml') ? ' class="vector"' : ''}></figure>
<article>
${endpoint ? `<p class="kicker">${endpoint.title}</p>` : ''}
<h1>${subject}</h1>
${endpoint ? `<p class="summary">${endpoint.summary}</p>
<h2>Endpoint</h2>
<pre><code>GET ${endpoint.route}</code></pre>
${params('Path parameters', endpoint.path)}${params('Query parameters', endpoint.query)}` : ''}
<h2>Responses</h2>
<dl class="statuses">${statuses.map(([status, doc]) => `<dt><code>${status}</code></dt><dd>${doc}</dd>`).join('')}</dl>
${endpoint ? `<h2>Related</h2>
<ul>${endpoint.related.map(([label, path]) => `<li><a href="${escapeHtml(path)}">${label}</a><code>${escapeHtml(decode(path))}</code></li>`).join('')}</ul>` : ''}
</article>
</main>
<footer>Opened in a browser tab, an image endpoint shows this page. <code>&lt;img&gt;</code>, <code>fetch()</code> and API clients get the image itself.</footer>
</body>
</html>
`;
}

export const mediaView = async (c: Context, next: Next) => {
  await next();
  if (c.req.method !== 'GET' || c.req.header('Sec-Fetch-Dest') !== 'document') return;
  if (!c.res.ok || !isMediaResponse(c.res.headers)) return;

  const page = renderPage(new URL(c.req.url), c.res);
  // Assigning c.res copies the media response's headers onto the page (its
  // CSP, Cache-Control, Content-Length): drop the media response first.
  c.res = undefined;
  c.res = new Response(page, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': MEDIA_VIEW_CONTENT_SECURITY_POLICY,
      'Cache-Control': 'no-store',
      Vary: 'Sec-Fetch-Dest',
    },
  });
};
