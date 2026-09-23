import { describe, it, expect, vi, afterEach } from 'vitest';
import { AvatarService } from '../src/services/avatar';
import { NETWORKS } from '../src/config/networks';
import {
  fetchMediaUrl,
  assertFetchableMediaUrl,
  BlockedMediaUrlError,
  SELF_HOSTNAMES,
  MAX_MEDIA_REDIRECTS,
  resolverDenyList,
} from '../src/services/media-fetch';

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
    ['the workers.dev deployment', 'https://ens-metadata-v2.ensdomains.workers.dev/mainnet/avatar/x.eth'],
    ['the workers.dev deployment, trailing dot', 'https://ens-metadata-v2.ensdomains.workers.dev./x'],
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

  it.each([
    'https://ipfs.io/ipfs/bafy/avatar.png',
    'https://example.com:8443/a.png',
    'http://93.184.216.34/a.png',
    'https://notmetadata.ens.domains.example.com/a.png',
  ])('allows a public URL: %s', (url) => {
    expect(blocked(url)).toBe(false);
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
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.sepolia.chain, undefined, NETWORKS.sepolia.v2.universalResolver);
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
