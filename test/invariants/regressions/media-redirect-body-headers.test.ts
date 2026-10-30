import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMediaUrl } from '../../../src/services/media-fetch';

/**
 * W8-MEDIA-002: Fetch-spec redirect semantics — a redirect that changes POST to
 * GET without a body removes every Fetch request-body header.
 *
 * Minimized input: HTTP 301 redirects a POST carrying `Content-Encoding: gzip`
 * and a body to another public media URL.
 *
 * Expected: The redirected GET has no body and no `Content-Encoding`; unrelated
 * `Accept` remains.
 */
describe('M3 redirect body headers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('strips every request-body header when a 301 redirect changes POST to GET', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'https://target.example/media' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchMediaUrl('https://origin.example/media', {
      method: 'POST',
      body: 'payload',
      headers: {
        'Content-Encoding': 'gzip',
        Accept: 'image/*',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const redirectedInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(redirectedInit.method).toBe('GET');
    expect(redirectedInit.body).toBeUndefined();

    const redirectedHeaders = new Headers(redirectedInit.headers);
    // The Fetch spec says every request-body header is removed:
    expect(redirectedHeaders.has('content-encoding')).toBe(false);
    expect(redirectedHeaders.has('content-language')).toBe(false);
    expect(redirectedHeaders.has('content-location')).toBe(false);
    expect(redirectedHeaders.has('content-type')).toBe(false);
    // Unrelated headers survive the redirect:
    expect(redirectedHeaders.get('accept')).toBe('image/*');
  });

  it('strips every request-body header when a 302 redirect changes POST to GET', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://target.example/media' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchMediaUrl('https://origin.example/media', {
      method: 'POST',
      body: 'payload',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Language': 'en',
        Accept: 'text/html',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const redirectedInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(redirectedInit.method).toBe('GET');
    expect(redirectedInit.body).toBeUndefined();

    const redirectedHeaders = new Headers(redirectedInit.headers);
    expect(redirectedHeaders.has('content-encoding')).toBe(false);
    expect(redirectedHeaders.has('content-language')).toBe(false);
    expect(redirectedHeaders.has('content-location')).toBe(false);
    expect(redirectedHeaders.has('content-type')).toBe(false);
    expect(redirectedHeaders.get('accept')).toBe('text/html');
  });

  // A 303 redirect of a GET has no body and must not strip any headers —
  // there were no request-body headers to delete, and removing unrelated
  // headers like Accept would be a regression.
  it('a 303 redirect preserves GET method and all headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 303, headers: { Location: 'https://target.example/media' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchMediaUrl('https://origin.example/media', {
      method: 'GET',
      headers: {
        'Content-Encoding': 'gzip',
        'Content-Language': 'en',
        'Content-Location': '/alt',
        'Content-Type': 'text/plain',
        Accept: 'image/*',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const redirectedInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(redirectedInit.method).toBe('GET');
    expect(redirectedInit.body).toBeUndefined();

    const redirectedHeaders = new Headers(redirectedInit.headers);
    // No body was sent, so every header is preserved:
    expect(redirectedHeaders.get('content-encoding')).toBe('gzip');
    expect(redirectedHeaders.get('content-language')).toBe('en');
    expect(redirectedHeaders.get('content-location')).toBe('/alt');
    expect(redirectedHeaders.get('content-type')).toBe('text/plain');
    expect(redirectedHeaders.get('accept')).toBe('image/*');
  });

  // HEAD through 303 likewise has no body — every header must survive.
  it('a 303 redirect preserves HEAD method and all headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 303, headers: { Location: 'https://target.example/media' } }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchMediaUrl('https://origin.example/media', {
      method: 'HEAD',
      headers: {
        'Content-Encoding': 'gzip',
        'Content-Language': 'en',
        'Content-Location': '/alt',
        'Content-Type': 'text/plain',
        Accept: 'image/*',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const redirectedInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(redirectedInit.method).toBe('HEAD');
    expect(redirectedInit.body).toBeUndefined();

    const redirectedHeaders = new Headers(redirectedInit.headers);
    expect(redirectedHeaders.get('content-encoding')).toBe('gzip');
    expect(redirectedHeaders.get('content-language')).toBe('en');
    expect(redirectedHeaders.get('content-location')).toBe('/alt');
    expect(redirectedHeaders.get('content-type')).toBe('text/plain');
    expect(redirectedHeaders.get('accept')).toBe('image/*');
  });
});