import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMediaUrl } from '../../src/services/media-fetch';

// Blind acceptance test for W8-MEDIA-001. Drives fetchMediaUrl, the function
// the ticket names. A 3xx is a redirect only for 301, 302, 303, 307, and 308.
// HTTP 300 with Location is the minimized case: one guarded fetch, then that
// 300 response, not the second URL's 200.

const FIRST = 'https://first.example/image';
const SECOND = 'https://second.example/image';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubChain(status: number, body: string): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = String(url);
    calls.push(target);
    if (target === FIRST) {
      return new Response(body, { status, headers: { Location: SECOND } });
    }
    return new Response('followed', { status: 200 });
  }));
  return calls;
}

describe('W8-MEDIA-001 Fetch redirect statuses', () => {
  it('returns the HTTP 300 response after one guarded fetch', async () => {
    const calls = stubChain(300, 'multiple-choices');

    const response = await fetchMediaUrl(FIRST);

    expect(response.status).toBe(300);
    expect(await response.text()).toBe('multiple-choices');
    expect(calls).toEqual([FIRST]);
  });

  it('does not follow another non-redirect 3xx that carries Location', async () => {
    const calls = stubChain(304, 'not-modified');

    const response = await fetchMediaUrl(FIRST);

    expect(response.status).toBe(304);
    expect(await response.text()).toBe('not-modified');
    expect(calls).toEqual([FIRST]);
  });
});
