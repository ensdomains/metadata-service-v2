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
//    (see media-view.ts), so a browser cache must not hand one to the other.
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

export function isMediaResponse(headers: Headers): boolean {
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
