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
});