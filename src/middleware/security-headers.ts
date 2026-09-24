import type { Context, Next } from 'hono';

// Security headers on every response (WEB-1548).
//
// This service answers with JSON, plain text and images, never with an HTML
// application, so:
//  - every response is X-Content-Type-Options: nosniff, so a browser never
//    reinterprets one (say, JSON that echoes a name) as HTML or script;
//  - a response without a Content-Security-Policy of its own gets one that
//    allows nothing and cannot be framed. Media (image/*) is left alone: the
//    NFT card and the avatars are embedded by other sites, and the media routes
//    set a CSP that fits their content;
//  - no X-Frame-Options: frame-ancestors covers the JSON responses, and media
//    must stay embeddable.
//
// hono/secure-headers is not used: it overwrites a CSP a handler already set,
// and its defaults (Cross-Origin-Resource-Policy: same-origin, X-Frame-Options)
// would block the cross-origin embedding the images exist for.
//
// The headers are applied after next(), so registered before every other
// middleware this also covers middleware short-circuits (CORS preflight, rate
// limit, validation errors, trailing-slash redirects), notFound, onError
// (including the timeout's 504) and edge-cache hits.

export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

function isMediaResponse(headers: Headers): boolean {
  return /^image\//i.test(headers.get('Content-Type') ?? '');
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

  if (!headers.has('Content-Security-Policy') && !isMediaResponse(headers)) {
    headers.set('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
  }
};
