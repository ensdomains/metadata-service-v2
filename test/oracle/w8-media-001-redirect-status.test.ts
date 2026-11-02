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

function stubChain(status: number, body: string | null): string[] {
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

    expect({ status: response.status, body: await response.text(), calls }).toEqual({
      status: 300,
      body: 'multiple-choices',
      calls: [FIRST],
    });
  });

  it('does not follow another non-redirect 3xx that carries Location', async () => {
    // 304 cannot carry a body. Null body, status, and the single call are the
    // observable: following it would return the second URL's 200.
    const calls = stubChain(304, null);

    const response = await fetchMediaUrl(FIRST);

    expect({ status: response.status, calls }).toEqual({
      status: 304,
      calls: [FIRST],
    });
  });
});
