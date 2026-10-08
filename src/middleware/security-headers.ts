import type { Context, Next } from 'hono';

// Security headers on every response (WEB-1548).
//
// This service answers with JSON, plain text and images, never with an HTML
// application, so:
//  - every response is X-Content-Type-Options: nosniff, so a browser never
//    reinterprets one (say, JSON that echoes a name) as HTML or script;
//  - a response without a Content-Security-Policy of its own gets one that
//    allows nothing, cannot be framed and is sandboxed: one a browser renders
//    as HTML loads nothing, runs no script, cannot use a <base> or submit a
//    form, and gets an opaque origin (a CSP does not affect fetch() or XHR
//    readers of the JSON). Media (a single image/* type) gets the sandboxing
//    media policy instead, supplied here whenever the route has not set its
//    own: the NFT card and the avatars are embedded by other sites, so they
//    must stay frameable, and an SVG opened as a document must not run script;
//  - a Content-Type that lists several types is not media: browsers use the
//    last one, so "image/png, text/html" is rendered as HTML;
//  - no X-Frame-Options: frame-ancestors covers the JSON responses, and media
//    must stay embeddable;
//  - media varies on Sec-Fetch-Dest: a browser tab gets the media page instead
//    (see mediaView), so a browser cache must not hand one to the other.
//
// hono/secure-headers is not used: it overwrites a CSP a handler already set,
// and its defaults (Cross-Origin-Resource-Policy: same-origin, X-Frame-Options)
// would block the cross-origin embedding the images exist for.
//
// The headers are applied after next(), so registered before every other
// middleware this also covers middleware short-circuits (CORS preflight, rate
// limit, validation errors, trailing-slash redirects), notFound, onError
// (including the timeout's 504) and edge-cache hits.

export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; sandbox";
export const MEDIA_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox";

// One image type, with parameters but no second type. Browsers split a
// Content-Type into types at each comma outside a double-quoted string (Fetch
// "get, decode, and split"), so a quoted parameter such as
// name="portrait,large.svg" does not start a second type. Parameters with a
// comma must keep every comma inside a closed quoted string that holds no
// backslash, so the split never depends on how a browser ends an unclosed
// string or reads a backslash escape; parameters without a comma are one type
// however they are read. Only HTTP whitespace (tab, space) may surround the
// type, as browsers parse it; \s would also accept \v or NBSP before it.
const SINGLE_IMAGE_TYPE = /^[\t ]*image\/[\w!#$&^.+-]+[\t ]*(;([^,]*|([^",]|"[^"\\]*")*))?$/i;

function isMediaResponse(headers: Headers): boolean {
  return SINGLE_IMAGE_TYPE.test(headers.get('Content-Type') ?? '');
}

export const securityHeaders = async (c: Context, next: Next) => {
  await next();

  let headers = c.res.headers;
  try {
    headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    // Immutable headers (a Response straight from fetch(), the Cache API or
    // Response.redirect()): copy the response so they can be added.
    c.res = new Response(c.res.body, c.res);
    headers = c.res.headers;
    headers.set('X-Content-Type-Options', 'nosniff');
  }

  const media = isMediaResponse(headers);
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', media ? MEDIA_CONTENT_SECURITY_POLICY : API_CONTENT_SECURITY_POLICY);
  }
  if (media) headers.append('Vary', 'Sec-Fetch-Dest');
};

// Media opened in a browser tab (a top-level navigation, Sec-Fetch-Dest:
// document) is shown on a page of this service that draws it with <img>, as the
// v1 service did. A browser runs no script, follows no link and loads nothing
// from an image drawn by <img>, whatever its bytes, and the tab shows this page
// instead of a document the name's owner wrote. The page loads the same URL as
// an image (an edge-cache hit after this request), so it holds nothing the owner
// controls. Everything else gets the media itself: <img>, iframes, API clients,
// and browsers that send no Fetch Metadata, which still get the sandboxing CSP
// and, for SVG, the sanitized document.
export const MEDIA_VIEW_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export const mediaView = async (c: Context, next: Next) => {
  await next();
  if (c.req.method !== 'GET' || c.req.header('Sec-Fetch-Dest') !== 'document') return;
  if (!c.res.ok || !isMediaResponse(c.res.headers)) return;

  const url = new URL(c.req.url);
  let title = url.pathname;
  try {
    title = decodeURIComponent(title);
  } catch {
    // malformed percent-encoding: show the path as requested
  }
  const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#0e0e0e}img{max-width:100%;max-height:100%}</style>
</head>
<body><img src="${escapeHtml(url.pathname + url.search)}" alt="${escapeHtml(title)}"></body>
</html>
`;
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
