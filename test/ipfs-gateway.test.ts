import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AvatarResolver, utils as avatarUtils } from '@ensdomains/ens-avatar';
import { mainnet } from 'viem/chains';
import { createMockEnv } from './mocks/hono-env';
import { AvatarService } from '../src/services/avatar';
import { DEFAULT_IPFS_GATEWAY, parseIpfsGateway, toLiveGatewayUrl } from '../src/services/ipfs-gateway';

// The public ipfs.io gateway (and dweb.link, w3s.link, nftstorage.link) stopped
// serving plain HTTP fetches on 2026-09-21: every request gets a 429 saying it is
// "switching to a service worker gateway only". ens-avatar resolves ipfs://
// records to ipfs.io unless it is given another gateway, so every IPFS avatar
// failed. Avatar media now goes through IPFS_GATEWAY (default Filebase).

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class { async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); } },
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GW = 'https://gw.example';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseIpfsGateway', () => {
  it.each([
    [undefined, DEFAULT_IPFS_GATEWAY],
    ['', DEFAULT_IPFS_GATEWAY],
    ['https://my-gw.myfilebase.com', 'https://my-gw.myfilebase.com'],
    ['https://my-gw.myfilebase.com/', 'https://my-gw.myfilebase.com'],
    ['https://my-gw.myfilebase.com/ipfs/', 'https://my-gw.myfilebase.com'],
    ['http://my-gw.example', DEFAULT_IPFS_GATEWAY],
    ['my-gw.example', DEFAULT_IPFS_GATEWAY],
  ])('%j → %s', (value, expected) => {
    expect(parseIpfsGateway(value)).toBe(expected);
  });

  it('defaults to Filebase', () => {
    expect(DEFAULT_IPFS_GATEWAY).toBe('https://ipfs.filebase.io');
  });
});

describe('toLiveGatewayUrl', () => {
  it.each([
    ['https://ipfs.io/ipfs/QmHash/1.png', `${GW}/ipfs/QmHash/1.png`],
    ['http://ipfs.io/ipfs/QmHash', `${GW}/ipfs/QmHash`],
    ['https://gateway.ipfs.io/ipfs/QmHash?filename=a.png', `${GW}/ipfs/QmHash?filename=a.png`],
    ['https://dweb.link/ipns/name.eth/a.png', `${GW}/ipns/name.eth/a.png`],
    ['https://nftstorage.link/ipfs/bafyHash/a.json', `${GW}/ipfs/bafyHash/a.json`],
    ['https://cloudflare-ipfs.com/ipfs/QmHash', `${GW}/ipfs/QmHash`],
    ['https://bafybeihash.ipfs.dweb.link/', `${GW}/ipfs/bafybeihash`],
    ['https://bafybeihash.ipfs.w3s.link/a/b.png#x', `${GW}/ipfs/bafybeihash/a/b.png#x`],
    ['https://k51name.ipns.dweb.link/a', `${GW}/ipns/k51name/a`],
  ])('moves %s to the gateway', (url, expected) => {
    expect(toLiveGatewayUrl(url, GW)).toBe(expected);
  });

  it.each([
    'https://gateway.pinata.cloud/ipfs/QmHash',
    'https://ipfs.filebase.io/ipfs/QmHash',
    'https://ipfs.io/docs/concepts',
    'https://example.com/ipfs/QmHash',
    'https://bafybeihash.ipfs.example.com/a.png',
    'ipfs://QmHash',
    'data:image/png;base64,AAAA',
    'not a url',
  ])('leaves %s unchanged', (url) => {
    expect(toLiveGatewayUrl(url, GW)).toBe(url);
  });
});

// A resolver's IPFS gateway as a URL. ens-avatar 2.0.0-alpha.3 stores the
// option in canonical form ("https://gw.example/"); alpha.2 kept it as given.
const gatewayOf = (resolver: unknown) =>
  new URL((resolver as { options: { ipfs: string } }).options.ipfs).href;

describe('ens-avatar resolution through the gateway', () => {
  it('gives both resolvers the gateway', () => {
    const svc = new AvatarService('https://rpc.invalid', mainnet, undefined, '0x' + '11'.repeat(20), GW);
    const { resolver, legacyResolver } = svc as unknown as { resolver: AvatarResolver; legacyResolver: AvatarResolver };
    expect(gatewayOf(resolver)).toBe(new URL(GW).href);
    expect(gatewayOf(legacyResolver)).toBe(new URL(GW).href);
  });

  it('defaults both resolvers to Filebase', () => {
    const svc = new AvatarService('https://rpc.invalid', mainnet);
    expect(gatewayOf((svc as unknown as { resolver: AvatarResolver }).resolver)).toBe(new URL(DEFAULT_IPFS_GATEWAY).href);
  });

  it('gives the resolvers a gateway ens-avatar accepts, whatever IPFS_GATEWAY carries', () => {
    // alpha.3 throws on a gateway with a query, fragment or credentials, which
    // would fail every avatar request; IPFS_GATEWAY is reduced to its origin.
    const gateway = parseIpfsGateway('https://user:pass@my-gw.example/some/path?x=1#y');
    expect(gateway).toBe('https://my-gw.example');
    const svc = new AvatarService('https://rpc.invalid', mainnet, undefined, '0x' + '11'.repeat(20), gateway);
    expect(gatewayOf((svc as unknown as { resolver: AvatarResolver }).resolver)).toBe('https://my-gw.example/');
  });

  it("the library resolves ipfs:// and ipns:// records and ipfs.io links with that option", () => {
    const gateways = { ipfs: GW };
    const cid = 'QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR';
    expect(avatarUtils.resolveURI(`ipfs://${cid}/1.png`, gateways).uri).toBe(`${GW}/ipfs/${cid}/1.png`);
    expect(avatarUtils.resolveURI('ipns://name.eth', gateways).uri).toBe(`${GW}/ipns/name.eth`);
    expect(avatarUtils.resolveURI('https://ipfs.io/ipfs/QmHash', gateways).uri).toBe(`${GW}/ipfs/QmHash`);
  });
});

describe('avatar media fetches', () => {
  it('fetches an image the library resolved to a retired gateway from the gateway', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return url.startsWith(GW) ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : new Response('retired', { status: 429 });
    }));
    const svc = new AvatarService('https://rpc.invalid', mainnet, undefined, undefined, GW);
    (svc as unknown as { resolver: { getAvatar: () => Promise<string> } }).resolver = {
      getAvatar: async () => 'https://nftstorage.link/ipfs/bafyHash/1.png',
    };

    const avatar = await svc.getAvatarImage('nick.eth');

    expect(avatar?.mimeType).toBe('image/png');
    expect(fetched).toEqual([`${GW}/ipfs/bafyHash/1.png`]);
  });

  it("routes the library's own fetches of a retired gateway link to the gateway", async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return Response.json({ image: 'ipfs://x' });
    }));
    const svc = new AvatarService('https://rpc.invalid', mainnet, undefined, undefined, GW);
    const { fetcher } = (svc as unknown as { resolver: { fetcher: { get: (url: string) => Promise<{ data: unknown }> } } }).resolver;

    const { data } = await fetcher.get('https://bafybeihash.ipfs.dweb.link/1.json');

    expect(data).toEqual({ image: 'ipfs://x' });
    expect(fetched).toEqual([`${GW}/ipfs/bafybeihash/1.json`]);
  });

  it('IPFS_GATEWAY reaches the resolvers through the Worker env', async () => {
    vi.resetModules();
    const { default: app } = await import('../src/index');
    const { AvatarResolver: Resolver } = await import('@ensdomains/ens-avatar');
    const gateways: string[] = [];
    vi.spyOn(Resolver.prototype, 'getAvatar').mockImplementation(async function (this: { options?: { ipfs?: string } }) {
      gateways.push(new URL(String(this.options?.ipfs)).href);
      return new URL('/ipfs/QmHash', this.options?.ipfs).href;
    });
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }));
    const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true', IPFS_GATEWAY: 'https://my-gw.myfilebase.com/' };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

    const res = await app.request('/mainnet/avatar/nick.eth', undefined, env as unknown as Record<string, unknown>, ctx);

    expect(res.status).toBe(200);
    expect(gateways).toEqual(['https://my-gw.myfilebase.com/']);
    expect(fetched).toEqual(['https://my-gw.myfilebase.com/ipfs/QmHash']);
  });
});
