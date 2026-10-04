import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMediaUrl } from '../src/services/media-fetch';

const FIRST_URL = 'https://first.example/image';
const SECOND_URL = 'https://second.example/image';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMediaUrl redirect statuses', () => {
  it('returns a 300 response with Location without fetching the target', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === FIRST_URL) {
        return new Response('first-response-body', {
          status: 300,
          headers: { Location: SECOND_URL },
        });
      }
      if (url === SECOND_URL) return new Response('second-response-body', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchMediaUrl(FIRST_URL);

    expect(response.status).toBe(300);
    expect(await response.text()).toBe('first-response-body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(FIRST_URL, expect.objectContaining({ redirect: 'manual' }));
    expect(fetchMock).not.toHaveBeenCalledWith(SECOND_URL, expect.anything());
  });

  it('also returns a 304 response with Location without fetching the target', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === FIRST_URL) {
        return new Response(null, {
          status: 304,
          headers: { Location: SECOND_URL },
        });
      }
      if (url === SECOND_URL) return new Response('second-response-body', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchMediaUrl(FIRST_URL);

    expect(response.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(FIRST_URL, expect.objectContaining({ redirect: 'manual' }));
    expect(fetchMock).not.toHaveBeenCalledWith(SECOND_URL, expect.anything());
  });
});
