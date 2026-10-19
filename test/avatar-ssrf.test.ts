import { describe, it, expect, vi, afterEach } from 'vitest';
import { AvatarResolver } from '@ensdomains/ens-avatar';
import { AvatarService } from '../src/services/avatar';
import { NETWORKS } from '../src/config/networks';
import {
  fetchMediaUrl,
  assertFetchableMediaUrl,
  BlockedMediaUrlError,
  SELF_HOSTNAMES,
  MAX_MEDIA_REDIRECTS,
  normalizeHostname,
  resolverDenyList,
  withServingHost,
} from '../src/services/media-fetch';
import { createMockEnv } from './mocks/hono-env';

// The app is loaded for the route test; its rasterizer needs WASM.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

// SSRF regression suite for avatar/header media fetches (WEB-1550, v1 cluster B).
//
// The avatar URL is chosen by the name's owner. AvatarService used to call
// fetch(uri) directly: redirects were followed automatically, nothing checked the
// final URL for a JSON-indirection record, and nothing stopped a record from
// pointing back at this service. Each case pins one bypass class from the v1
// bounty history.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function blocked(url: string): boolean {
  try {
    assertFetchableMediaUrl(new URL(url));
    return false;
  } catch (e) {
    expect(e).toBeInstanceOf(BlockedMediaUrlError);
    return true;
  }
}

describe('assertFetchableMediaUrl', () => {
  it.each([
    ['this service', 'https://metadata.ens.domains/mainnet/avatar/nick.eth'],
    ['this service, trailing-dot FQDN', 'https://metadata.ens.domains./mainnet/avatar/nick.eth'],
    ['this service, several trailing dots and mixed case', 'https://METADATA.ens.domains../x'],
    ['a subdomain of this service', 'https://a.metadata.ens.domains/x'],
    ['the workers.dev deployment', 'https://ens-metadata.ens-cf.workers.dev/mainnet/avatar/x.eth'],
    ['the workers.dev deployment, trailing dot', 'https://ens-metadata.ens-cf.workers.dev./x'],
  ])('blocks %s (anti-recursion)', (_label, url) => {
    expect(blocked(url)).toBe(true);
  });

  it.each([
    ['loopback', 'http://127.0.0.1/'],
    ['loopback, decimal-encoded IPv4', 'http://2130706433/'],
    ['loopback, hex-encoded IPv4', 'http://0x7f000001/'],
    ['loopback, trailing dot', 'http://127.0.0.1./'],
    ['RFC 1918', 'http://10.0.0.5/'],
    ['cloud metadata (link-local)', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6, hex form', 'http://[::ffff:7f00:1]/'],
    ['NAT64-embedded loopback', 'http://[64:ff9b::7f00:1]/'],
    ['IPv6 unique-local', 'http://[fd00::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['localhost', 'http://localhost/'],
    ['localhost, trailing dot', 'http://localhost./'],
    ['a .localhost name', 'http://svc.localhost/'],
    ['an .internal name', 'http://metadata.google.internal/'],
  ])('blocks a private target: %s', (_label, url) => {
    expect(blocked(url)).toBe(true);
  });

  it.each([
    ['ftp', 'ftp://example.com/a.png'],
    ['file', 'file:///etc/passwd'],
    ['a scheme that merely starts with "http"', 'httpx://example.com/a.png'],
  ])('blocks a non-http(s) scheme: %s', (_label, url) => {
    expect(blocked(url)).toBe(true);
  });

  // WEB-1550 / WEB-1555: the Worker's fetch() connects to the port the URL
  // names, so only the scheme's default port is allowed.
  it.each([
    ['8080', 'https://example.com:8080/a.png'],
    ['8443', 'https://example.com:8443/a.png'],
    ['6379 (Redis)', 'http://example.com:6379/'],
    ['22 (SSH)', 'https://example.com:22/'],
    ['443 on http:', 'http://example.com:443/a.png'],
    ['80 on https:', 'https://example.com:80/a.png'],
    ['on a public IP literal', 'http://93.184.216.34:8080/a.png'],
  ])('blocks a non-default port: %s', (_label, url) => {
    expect(blocked(url)).toBe(true);
    expect(() => assertFetchableMediaUrl(new URL(url))).toThrow(/port/);
  });

  it.each([
    'https://ipfs.io/ipfs/bafy/avatar.png',
    'https://example.com:443/a.png',
    'http://example.com:80/a.png',
    'http://93.184.216.34/a.png',
    'https://notmetadata.ens.domains.example.com/a.png',
  ])('allows a public URL: %s', (url) => {
    expect(blocked(url)).toBe(false);
  });
});

// Every hostname checked here is attacker-chosen (a record, a redirect
// Location, an OffchainLookup gateway URL), and the URL parser accepts hosts of
// any length. The trailing-dot regex /\.+$/ was quadratic on a long run of dots
// followed by a letter (40k dots: over 2 s of CPU per check).
describe('hostname handling stays linear', () => {
  it('normalizeHostname strips trailing dots without backtracking', () => {
    const host = new URL(`https://a${'.'.repeat(40_000)}b/x.png`).hostname;
    const started = performance.now();
    expect(normalizeHostname(host)).toBe(host);
    expect(performance.now() - started).toBeLessThan(200);
    expect(normalizeHostname('METADATA.ens.domains...')).toBe('metadata.ens.domains');
    expect(normalizeHostname('[::1]')).toBe('::1');
  });

  it('refuses hostnames longer than DNS allows before classifying them', () => {
    expect(blocked(`https://a${'.'.repeat(40_000)}b/x.png`)).toBe(true);
    expect(blocked(`https://${'a.'.repeat(130)}com/x.png`)).toBe(true); // 263 characters
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(longest).toHaveLength(253);
    expect(blocked(`https://${longest}./x.png`)).toBe(false); // the longest valid name, with its trailing dot
  });
});

describe('fetchMediaUrl follows redirects manually and checks every hop', () => {
  function stubFetch(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, redirect: init?.redirect });
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch ${url}`);
      return handler();
    }));
    return calls;
  }
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { Location: to } });

  it('never lets fetch follow redirects itself', async () => {
    const calls = stubFetch({ 'https://cdn.example/a.png': () => new Response(PNG) });
    await fetchMediaUrl('https://cdn.example/a.png');
    expect(calls).toEqual([{ url: 'https://cdn.example/a.png', redirect: 'manual' }]);
  });

  it('follows a public redirect chain, resolving relative Locations', async () => {
    const calls = stubFetch({
      'https://short.example/x': redirect('https://cdn.example/dir/a'),
      'https://cdn.example/dir/a': redirect('../img/a.png'),
      'https://cdn.example/img/a.png': () => new Response(PNG, { status: 200 }),
    });
    const res = await fetchMediaUrl('https://short.example/x');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      'https://short.example/x',
      'https://cdn.example/dir/a',
      'https://cdn.example/img/a.png',
    ]);
  });

  it('blocks a redirect chain that ends at the cloud metadata address, without requesting it', async () => {
    const calls = stubFetch({
      'https://attacker.example/a': redirect('https://hop.example/b'),
      'https://hop.example/b': redirect('http://169.254.169.254/latest/meta-data/'),
    });
    await expect(fetchMediaUrl('https://attacker.example/a')).rejects.toBeInstanceOf(BlockedMediaUrlError);
    expect(calls.map((c) => c.url)).not.toContain('http://169.254.169.254/latest/meta-data/');
  });

  it('blocks a redirect back to this service (trailing-dot form)', async () => {
    const calls = stubFetch({ 'https://attacker.example/a': redirect('https://metadata.ens.domains./mainnet/avatar/x.eth') });
    await expect(fetchMediaUrl('https://attacker.example/a')).rejects.toBeInstanceOf(BlockedMediaUrlError);
    expect(calls).toHaveLength(1);
  });

  it(`caps the chain at ${MAX_MEDIA_REDIRECTS} redirects`, async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i <= MAX_MEDIA_REDIRECTS + 1; i++) routes[`https://loop.example/${i}`] = redirect(`https://loop.example/${i + 1}`);
    const calls = stubFetch(routes);
    await expect(fetchMediaUrl('https://loop.example/0')).rejects.toThrow(/too many media redirects/);
    expect(calls).toHaveLength(MAX_MEDIA_REDIRECTS + 1);
  });

  it('rejects a blocked initial URL without any request', async () => {
    const calls = stubFetch({});
    await expect(fetchMediaUrl('http://[::1]/')).rejects.toBeInstanceOf(BlockedMediaUrlError);
    expect(calls).toHaveLength(0);
  });

  it('sends an explicit default port (:443, :80, also on a redirect hop) as the plain URL', async () => {
    const calls = stubFetch({
      'https://cdn.example/a.png': redirect('http://img.example:80/a.png'),
      'http://img.example/a.png': () => new Response(PNG, { status: 200 }),
    });
    const res = await fetchMediaUrl('https://cdn.example:443/a.png');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(['https://cdn.example/a.png', 'http://img.example/a.png']);
  });

  it.each(['8080', '6379', '22'])('rejects a first hop on port %s without any request', async (port) => {
    const calls = stubFetch({});
    await expect(fetchMediaUrl(`https://cdn.example:${port}/a.png`)).rejects.toThrow(BlockedMediaUrlError);
    await expect(fetchMediaUrl(`http://cdn.example:${port}/a.png`)).rejects.toThrow(/port/);
    expect(calls).toHaveLength(0);
  });

  it.each(['8080', '6379', '22'])('blocks a redirect to port %s without requesting it', async (port) => {
    const calls = stubFetch({
      'https://attacker.example/a': redirect(`https://attacker.example:${port}/b`),
      'https://attacker.example/c': redirect(`//other.example:${port}/`),
    });
    await expect(fetchMediaUrl('https://attacker.example/a')).rejects.toThrow(/port/);
    await expect(fetchMediaUrl('https://attacker.example/c')).rejects.toThrow(/port/);
    expect(calls.map((c) => c.url)).toEqual(['https://attacker.example/a', 'https://attacker.example/c']);
  });
});

describe('AvatarService uses the guard for every media fetch', () => {
  function serviceResolvingTo(uri: string): AvatarService {
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain);
    (svc as unknown as { resolver: unknown }).resolver = { getAvatar: vi.fn().mockResolvedValue(uri), getHeader: vi.fn().mockResolvedValue(uri) };
    (svc as unknown as { legacyResolver?: unknown }).legacyResolver = undefined;
    return svc;
  }

  it('an avatar record pointing at this service yields no avatar and no request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const img = await serviceResolvingTo('https://metadata.ens.domains/mainnet/avatar/self.eth').getAvatarImage('self.eth');
    expect(img).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a header redirecting to a private address yields no header and never reaches it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Behaves like the platform fetch: follows redirects itself unless the
    // caller asks for redirect: 'manual'.
    const requested: string[] = [];
    const origins: Record<string, () => Response> = {
      'https://attacker.example/h': () => new Response(null, { status: 301, headers: { Location: 'http://10.0.0.1/secret.png' } }),
      'http://10.0.0.1/secret.png': () => new Response(PNG, { status: 200 }),
    };
    const realisticFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      requested.push(url);
      const res = origins[url]();
      const location = res.headers.get('Location');
      if (location && init?.redirect !== 'manual') return realisticFetch(new URL(location, url).toString(), init);
      return res;
    };
    vi.stubGlobal('fetch', vi.fn(realisticFetch));
    expect(await serviceResolvingTo('https://attacker.example/h').getHeaderImage('evil.eth')).toBeNull();
    expect(requested).toEqual(['https://attacker.example/h']);
  });

  it('a normal public avatar still loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })));
    const img = await serviceResolvingTo('https://cdn.example/a.png').getAvatarImage('ok.eth');
    expect(img).not.toBeNull();
  });

  it('passes the self deny list (with trailing-dot forms) and a short timeout to the ens-avatar resolvers', () => {
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.sepolia.chain, undefined, '0x' + '11'.repeat(20));
    for (const key of ['resolver', 'legacyResolver'] as const) {
      const opts = (svc as unknown as Record<string, { options?: { urlDenyList?: string[]; timeout?: number } }>)[key].options;
      expect(opts?.urlDenyList).toEqual(expect.arrayContaining(['metadata.ens.domains', 'metadata.ens.domains.']));
      expect(opts?.timeout).toBeLessThanOrEqual(8_000);
    }
    expect(resolverDenyList()).toHaveLength(SELF_HOSTNAMES.length * 2);
  });
});

describe('media body size cap applies while streaming', () => {
  it('stops reading a body without Content-Length once it passes the cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = new Uint8Array(1024).fill(0x41);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 10_000) controller.close();
        else controller.enqueue(pulled === 1 ? new Uint8Array([...PNG, ...chunk.subarray(8)]) : chunk);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain, 4 * 1024);
    (svc as unknown as { resolver: unknown }).resolver = { getAvatar: vi.fn().mockResolvedValue('https://cdn.example/huge.png') };
    (svc as unknown as { legacyResolver?: unknown }).legacyResolver = undefined;

    expect(await svc.getAvatarImage('big.eth')).toBeNull();
    // 4 KiB cap with 1 KiB chunks: stops right after the cap, never drains 10 MB.
    expect(pulled).toBeLessThan(10);
  });

  it('a body within the cap is read whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { status: 200 })));
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain, 4 * 1024);
    (svc as unknown as { resolver: unknown }).resolver = { getAvatar: vi.fn().mockResolvedValue('https://cdn.example/a.png') };
    (svc as unknown as { legacyResolver?: unknown }).legacyResolver = undefined;
    const img = await svc.getAvatarImage('ok.eth');
    expect(img?.buffer.byteLength).toBe(PNG.byteLength);
  });
});

// The worker is also reachable on hosts other than SELF_HOSTNAMES: a preview
// URL per version or alias, another custom domain, a route. A record or gateway
// URL naming one of them would make the worker fetch its own endpoints, and the
// redirect limit does not bound recursion across separate requests.
describe("the worker's other hostnames", () => {
  it.each([
    'https://1a2b3c4d-ens-metadata-stage.ens-cf.workers.dev/mainnet/avatar/loop.eth',
    'https://ens-metadata-stage.ens-cf.workers.dev./mainnet/avatar/loop.eth',
    'https://ENS-METADATA-STAGE.ens-cf.workers.dev/x',
  ])('blocks its preview URL %s', (url) => {
    expect(blocked(url)).toBe(true);
  });

  it('does not block other workers on the same workers.dev subdomain', () => {
    expect(blocked('https://other-worker.ens-cf.workers.dev/a.png')).toBe(false);
  });

  it('blocks the host the current request is served on, and its subdomains', async () => {
    await withServingHost('Custom.Example', async () => {
      await Promise.resolve(); // still inside the request after an await
      for (const url of ['https://custom.example/mainnet/avatar/loop.eth', 'https://CUSTOM.example./x', 'https://img.custom.example/a.png']) {
        expect(blocked(url)).toBe(true);
      }
      for (const url of ['https://cdn.example/a.png', 'https://notcustom.example/a.png']) {
        expect(blocked(url)).toBe(false);
      }
    });
    // Only for that request.
    expect(blocked('https://custom.example/a.png')).toBe(false);
  });

  it('blocks a redirect to the serving host without requesting it', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 302, headers: { Location: 'https://custom.example/mainnet/avatar/loop.eth' } });
    }));
    await withServingHost('custom.example', async () => {
      await expect(fetchMediaUrl('https://attacker.example/r')).rejects.toBeInstanceOf(BlockedMediaUrlError);
    });
    expect(requested).toEqual(['https://attacker.example/r']);
  });

  it('through the app: an avatar record naming the host the request came in on is never fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const HOST = 'https://custom.example';
    vi.spyOn(AvatarResolver.prototype, 'getAvatar').mockResolvedValue(`${HOST}/mainnet/avatar/loop.eth`);
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }));
    const { default: app } = await import('../src/index');
    const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' } as unknown as Record<string, unknown>;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

    const loop = await app.request(`${HOST}/mainnet/avatar/loop.eth`, undefined, env, ctx);
    expect(loop.status).toBe(404);
    expect(requested).toEqual([]);

    // The same record, requested on another host, is an ordinary public URL.
    const other = await app.request('https://metadata.test/mainnet/avatar/loop.eth', undefined, env, ctx);
    expect(other.status).toBe(200);
    expect(requested).toEqual([`${HOST}/mainnet/avatar/loop.eth`]);
  });
});
