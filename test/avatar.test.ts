import { describe, it, expect, vi } from 'vitest';
import { HttpRequestError } from 'viem';
import { AvatarResolver, utils, type ChainClient, type Fetcher, type ReadContractParams } from '@ensdomains/ens-avatar';
import { AvatarService } from '../src/services/avatar';
import { UpstreamError } from '../src/services/errors';
import { NETWORKS } from '../src/config/networks';

// A minimal stand-in for @ensdomains/ens-avatar's AvatarResolver — only
// getMetadata (and the chain client it reads the record through) is exercised
// by getAvatarMeta.
type FakeResolver = { getMetadata: ReturnType<typeof vi.fn>; client?: FakeClient };
type FakeClient = { getEnsRecord: ReturnType<typeof vi.fn>; readContract: ReturnType<typeof vi.fn> };

// A chain client whose `avatar` text record is `record`.
const fakeClient = (record: string | null): FakeClient => ({
  getEnsRecord: vi.fn().mockResolvedValue({ record, address: null }),
  readContract: vi.fn(),
});

// A fake resolver that, like ens-avatar, reads the avatar record through its
// chain client before returning `meta`.
function readingResolver(record: string, meta: unknown): FakeResolver {
  return {
    client: fakeClient(record),
    getMetadata: vi.fn(async function (this: { client: FakeClient }, ens: string) {
      await this.client.getEnsRecord(ens, 'avatar');
      return meta;
    }),
  };
}

// Build a real AvatarService, then swap in fake resolvers so no RPC/network is
// touched (the constructor only wires viem/ens-avatar lazily; nothing fires until
// a resolver method is called).
function makeService(primary: FakeResolver, legacy?: FakeResolver): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain);
  for (const resolver of [primary, legacy]) {
    if (resolver && !resolver.client) resolver.client = fakeClient(null);
  }
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = legacy;
  return svc;
}

const NFT_RECORD = 'eip155:1/erc721:0xabc/1';

const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

// A 1x1 PNG: the library checks a raster data: URI's bytes against its type.
const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const IMG_URL = 'https://meta.test/mainnet/avatar/nick.eth';

describe('AvatarService.getAvatarMeta', () => {
  it('returns the full NFT metadata shape (host_meta + is_owner) verbatim', async () => {
    const meta = {
      uri: 'nick.eth',
      name: 'Cool NFT #1',
      description: 'a cool avatar',
      image: 'https://cdn.test/1.png',
      image_url: 'https://cdn.test/1.png',
      attributes: [{ trait_type: 'a', value: 'b' }],
      is_owner: true,
      host_meta: {
        chain_id: 1,
        namespace: 'erc721',
        contract_address: '0xabc',
        token_id: '1',
        reference_url: 'https://opensea.io/assets/0xabc/1',
      },
    };
    const primary = readingResolver(NFT_RECORD, meta);
    const svc = makeService(primary);

    const result = await svc.getAvatarMeta('nick.eth', IMG_URL);

    expect(result).toMatchObject({
      uri: 'nick.eth',
      name: 'Cool NFT #1',
      description: 'a cool avatar',
      image: 'https://cdn.test/1.png',
      is_owner: true,
      host_meta: expect.objectContaining({ contract_address: '0xabc', token_id: '1' }),
    });
    expect(result?.attributes).toEqual([{ trait_type: 'a', value: 'b' }]);
    // Resolver is queried with the ENSIP-15-normalized name.
    expect(primary.getMetadata).toHaveBeenCalledWith('nick.eth');
  });

  it('normalizes the name before resolving (uppercase → lowercase)', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'https://cdn.test/x.png' }) };
    await makeService(primary).getAvatarMeta('NICK.eth', IMG_URL);
    expect(primary.getMetadata).toHaveBeenCalledWith('nick.eth');
  });

  it('rewrites an ipfs:// image to a public gateway URL', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ uri: 'nick.eth', image: `ipfs://${CID}/pic.png` }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe(`https://ipfs.io/ipfs/${CID}/pic.png`);
  });

  it('rewrites the ipfs://ipfs/ prefix form', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: `ipfs://ipfs/${CID}` }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe(`https://ipfs.io/ipfs/${CID}`);
  });

  it('has no image for an ipfs:// URI that is not a CID, which the avatar endpoint does not serve either', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'ipfs://QmHash/pic.png' }) };
    expect(await makeService(primary).getAvatarMeta('nick.eth', IMG_URL)).toBeNull();
    expect(utils.getImageURI({ metadata: { image: 'ipfs://QmHash/pic.png' } })).toBeNull();
  });

  it('rewrites an ar:// image to the Arweave gateway', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'ar://TXID' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://arweave.net/TXID');
  });

  it('leaves an http(s) image URL untouched', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'https://cdn.test/a.png' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://cdn.test/a.png');
  });

  it('falls back to image_url when image is absent', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image_url: 'https://cdn.test/x.png' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://cdn.test/x.png');
  });

  it('points image at the avatar image endpoint for inline image_data', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image_data: '<svg/>' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe(IMG_URL);
    // The inline markup itself is not echoed: the image endpoint serves it.
    expect(result).not.toHaveProperty('image_data');
  });

  it('returns null when the name has no avatar record', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue(null) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toBeNull();
  });

  it('returns null when metadata has no usable image field', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ name: 'no image here' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth'); // no avatarImageUrl
    expect(result).toBeNull();
  });

  it('treats image_data as unusable when no avatar image URL is supplied', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image_data: '<svg/>' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth'); // no avatarImageUrl
    expect(result).toBeNull();
  });

  it('falls back to the legacy resolver when the primary finds nothing', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue(null) };
    const legacy = { getMetadata: vi.fn().mockResolvedValue({ image: 'https://cdn.test/legacy.png' }) };
    const result = await makeService(primary, legacy).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://cdn.test/legacy.png');
    expect(primary.getMetadata).toHaveBeenCalled();
    expect(legacy.getMetadata).toHaveBeenCalled();
  });

  it('does not consult the legacy resolver when the primary already resolved', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'https://cdn.test/primary.png' }) };
    const legacy = { getMetadata: vi.fn().mockResolvedValue({ image: 'https://cdn.test/legacy.png' }) };
    const result = await makeService(primary, legacy).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://cdn.test/primary.png');
    expect(legacy.getMetadata).not.toHaveBeenCalled();
  });

  it('fails the lookup (UpstreamError, not null) when resolution throws (e.g. RPC down)', async () => {
    const rpcDown = new HttpRequestError({ url: 'https://rpc.invalid', status: 503 });
    const primary = { getMetadata: vi.fn().mockRejectedValue(rpcDown) };
    await expect(makeService(primary).getAvatarMeta('nick.eth', IMG_URL)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('returns null for a non-normalizable name without hitting the resolver', async () => {
    const primary = { getMetadata: vi.fn() };
    // "in_valid" — underscore mid-label — is rejected by ENSIP-15 normalization.
    const result = await makeService(primary).getAvatarMeta('in_valid.eth', IMG_URL);
    expect(result).toBeNull();
    expect(primary.getMetadata).not.toHaveBeenCalled();
  });
});

describe('AvatarService.getAvatarMeta sanitization', () => {
  // getMetadata returns metadata as published: every field below is chosen by
  // the record/token owner, and /meta consumers render them.
  const uriMeta = (meta: Record<string, unknown>) => readingResolver('https://cdn.test/avatar.json', meta);

  it.each([
    'javascript:alert(document.domain)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  ])('treats a non-image image value (%j) as no usable image', async (image) => {
    const result = await makeService(uriMeta({ image, name: 'x' })).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toBeNull();
  });

  it('does not skip an unusable image for a later field (the avatar endpoint would not either)', async () => {
    const primary = uriMeta({ image: 'javascript:alert(1)', image_url: 'https://cdn.test/ok.png' });
    expect(await makeService(primary).getAvatarMeta('nick.eth', IMG_URL)).toBeNull();
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
    '  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+',
    PNG_DATA_URI,
  ])('replaces an inline image (%j) with the avatar image URL', async (image) => {
    const result = await makeService(uriMeta({ image, image_url: image })).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe(IMG_URL);
    expect(result?.image_url).toBe(IMG_URL);
    const body = JSON.stringify(result);
    expect(body).not.toContain('data:');
    expect(body).not.toContain('<');
  });

  it.each([
    ['a URL-encoded SVG data: URI', 'data:image/svg+xml,%3Csvg%20onload%3D%22alert(1)%22%2F%3E'],
    ['an SVG data: URI with a charset', `data:image/svg+xml;charset=utf-8;base64,${Buffer.from('<svg/>').toString('base64')}`],
    ['an upper-case SVG data: URI', `DATA:IMAGE/SVG+XML;base64,${Buffer.from('<svg/>').toString('base64')}`],
    ['a PNG data: URI whose bytes are not a PNG', 'data:image/png;base64,iVBORw0KGgo='],
  ])('has no image for an inline image the avatar endpoint does not serve (%s)', async (_, image) => {
    // The endpoint serves what ens-avatar resolves, which is nothing for these;
    // an avatar image URL here would point at a 404.
    expect(utils.getImageURI({ metadata: { image } })).toBeNull();
    expect(await makeService(uriMeta({ image })).getAvatarMeta('nick.eth', IMG_URL)).toBeNull();
  });

  it.each([
    ['an inline image_url behind a remote image, which the endpoint does not serve, is dropped',
      { image: 'https://cdn.test/a.png', image_url: PNG_DATA_URI }, { image: 'https://cdn.test/a.png' }],
    ['an inline image_url that is the image the endpoint serves is the avatar image URL',
      { image: '', image_url: PNG_DATA_URI }, { image: IMG_URL, image_url: IMG_URL }],
    ['a remote image_url behind an inline image is kept',
      { image: PNG_DATA_URI, image_url: 'https://cdn.test/b.png' }, { image: IMG_URL, image_url: 'https://cdn.test/b.png' }],
  ])('image_url: %s', async (_, meta, expected) => {
    const result = await makeService(uriMeta({ name: 'x', ...meta })).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({ name: 'x', uri: 'nick.eth', ...expected });
  });

  it('never echoes image_data, even next to an http(s) image', async () => {
    const primary = uriMeta({ image: 'https://cdn.test/a.png', image_data: '<svg onload="alert(1)"/>' });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://cdn.test/a.png');
    expect(result).not.toHaveProperty('image_data');
  });

  it('treats an inline image as unusable when no avatar image URL is supplied', async () => {
    const primary = uriMeta({ image: PNG_DATA_URI });
    expect(await makeService(primary).getAvatarMeta('nick.eth')).toBeNull();
  });

  it('keeps http(s) image fields and drops a non-http(s) image_url', async () => {
    const primary = uriMeta({ image: 'http://cdn.test/a.png', image_url: 'javascript:alert(1)' });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('http://cdn.test/a.png');
    expect(result).not.toHaveProperty('image_url');
  });

  it('rewrites ipfs/ipns/ar media links to gateways', async () => {
    const primary = uriMeta({
      image: 'ipns://k51qzi5uqu5dlvj2/pic.png',
      image_url: 'ipfs://QmHash/pic.png',
      animation_url: 'ar://TXID',
      external_url: 'ipfs://ipfs/QmSite',
    });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toMatchObject({
      image: 'https://ipfs.io/ipns/k51qzi5uqu5dlvj2/pic.png',
      image_url: 'https://ipfs.io/ipfs/QmHash/pic.png',
      animation_url: 'https://arweave.net/TXID',
      external_url: 'https://ipfs.io/ipfs/QmSite',
    });
  });

  it.each([
    [CID, `https://ipfs.io/ipfs/${CID}`],
    [`ipfs/${CID}/1.png`, `https://ipfs.io/ipfs/${CID}/1.png`],
    [`/ipfs/${CID}/1.png`, `https://ipfs.io/ipfs/${CID}/1.png`],
    [
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      'https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    ],
    ['/ipns/example.eth/pic.png', 'https://ipfs.io/ipns/example.eth/pic.png'],
  ])('resolves a CID-path image (%s) as the avatar endpoint does, keeping the NFT response', async (image, expected) => {
    const host_meta = { chain_id: 1, namespace: 'erc721', contract_address: '0xabc', token_id: '1' };
    const primary = readingResolver(NFT_RECORD, { image, is_owner: true, host_meta });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toMatchObject({ image: expected, is_owner: true, host_meta });
  });

  it('resolves CID paths in link fields, but not data:-wrapped, script or over-long values', async () => {
    // 512 characters: the longest value the service resolves as a storage path.
    const withinCap = `ipfs/${CID}/${'a'.repeat(512 - `ipfs/${CID}/`.length)}`;
    const primary = uriMeta({
      image: `ipfs/${CID}/1.png`,
      image_url: 'data:,https://cdn.test/x.png',
      animation_url: withinCap,
      external_url: `${withinCap}a`,
      youtube_url: `javascript:${CID}`,
    });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({
      uri: 'nick.eth',
      image: `https://ipfs.io/ipfs/${CID}/1.png`,
      animation_url: `https://ipfs.io/${withinCap}`,
    });
  });

  it('keeps only http(s) link fields and leaves unrelated fields alone', async () => {
    const primary = uriMeta({
      image: 'https://cdn.test/a.png',
      name: 'Name <b>as published</b>',
      description: 'desc',
      attributes: [{ trait_type: 't', value: 'v' }],
      background_color: 'ffffff',
      animation_url: 'https://cdn.test/anim.mp4',
      external_url: 'javascript:alert(1)',
      external_link: 'data:text/html,<script>alert(1)</script>',
      youtube_url: 'vbscript:msgbox(1)',
    });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({
      uri: 'nick.eth',
      image: 'https://cdn.test/a.png',
      name: 'Name <b>as published</b>',
      description: 'desc',
      attributes: [{ trait_type: 't', value: 'v' }],
      background_color: 'ffffff',
      animation_url: 'https://cdn.test/anim.mp4',
    });
  });

  // Values that only the http(s)-only link rule rewrites or drops.
  it.each([
    ['permalink', `ipfs://${CID}/p`, `https://ipfs.io/ipfs/${CID}/p`],
    ['image_preview_url', 'ftp://cdn.test/p.png', undefined],
    ['image_thumbnail_url', `ipfs://${CID}/thumb.png`, `https://ipfs.io/ipfs/${CID}/thumb.png`],
    ['image_original_url', 'file:///etc/passwd', undefined],
    ['animation_original_url', 'HTTPS://CDN.test/a.mp4', 'https://cdn.test/a.mp4'],
  ])('keeps the OpenSea URL field %s (%j) only as an http(s) link', async (field, value, expected) => {
    const primary = uriMeta({ image: 'https://cdn.test/a.png', [field]: value });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({
      uri: 'nick.eth',
      image: 'https://cdn.test/a.png',
      ...(expected === undefined ? {} : { [field]: expected }),
    });
  });

  it('drops script and data: URLs at any depth, however a browser would spell them', async () => {
    const primary = uriMeta({
      image: 'https://cdn.test/a.png',
      description: 'Mentions javascript: and data: in prose',
      note: 'Data: 42',
      properties: {
        image: 'java\tscript:alert(1)',
        animation_url: 'data:text/html,<script>alert(1)</script>',
        files: [{ uri: ' \x01VbScript:msgbox(1)', type: 'image/png' }, { uri: 'https://cdn.test/f.png' }],
        creator: { url: 'JAVA\nSCRIPT:alert(1)', name: 'ok' },
      },
      attributes: [
        { trait_type: 'link', value: '\x00javascript:alert(1)' },
        { trait_type: 'n', value: 3 },
        'data:,inline',
        'plain',
      ],
    });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({
      uri: 'nick.eth',
      image: 'https://cdn.test/a.png',
      description: 'Mentions javascript: and data: in prose',
      note: 'Data: 42',
      properties: {
        files: [{ type: 'image/png' }, { uri: 'https://cdn.test/f.png' }],
        creator: { name: 'ok' },
      },
      attributes: [{ trait_type: 'link' }, { trait_type: 'n', value: 3 }, 'plain'],
    });
  });

  it.each([
    '\u00a0javascript:alert(1)',
    '\ufeffjavascript:alert(1)',
    '\u3000\u2028VBSCRIPT:msgbox(1)',
    '\u00a0\x01data:text/html,<script>alert(1)</script>',
    '\u0085javascript:alert(1)',
  ])('drops a script or data: URL behind leading Unicode whitespace (%j), which a consumer may trim', async (value) => {
    const primary = uriMeta({ image: 'https://cdn.test/a.png', note: value, properties: { link: value, name: 'ok' } });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({ uri: 'nick.eth', image: 'https://cdn.test/a.png', properties: { name: 'ok' } });
  });

  it('drops prose that parses as a data: URL (the cost of the data: rule) and keeps other prose', async () => {
    const primary = uriMeta({
      image: 'https://cdn.test/a.png',
      description: 'Data: 10,000 hand-drawn avatars',
      note: 'Data: 42',
    });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({ uri: 'nick.eth', image: 'https://cdn.test/a.png', note: 'Data: 42' });
  });

  it('drops metadata nested past the depth limit and __proto__ keys', async () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const primary = uriMeta(JSON.parse(JSON.stringify({
      image: 'https://cdn.test/a.png',
      shallow: { a: { b: 'kept' } },
      deep,
    }).replace('"shallow":{', '"__proto__":{"polluted":true},"shallow":{"__proto__":{"polluted":true},')));
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toMatchObject({ image: 'https://cdn.test/a.png', shallow: { a: { b: 'kept' } } });
    expect(Object.keys(result!)).not.toContain('__proto__');
    expect(Object.keys(result!.shallow as object)).toEqual(['a']);
    expect(Object.getPrototypeOf(result!.shallow)).toBe(Object.prototype);
    let depth = 0;
    for (let node = result!.deep as Record<string, unknown> | undefined; node; node = node.next as Record<string, unknown> | undefined) depth++;
    expect(depth).toBe(16); // MAX_META_DEPTH levels are kept; the rest is dropped
    expect(JSON.stringify(result)).not.toContain('leaf');
  });

  it('drops is_owner/host_meta that a non-NFT record supplies itself', async () => {
    const primary = uriMeta({
      image: 'https://cdn.test/a.png',
      is_owner: true,
      host_meta: { chain_id: 1, namespace: 'erc721', contract_address: '0xabc', token_id: '1' },
    });
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://cdn.test/a.png');
    expect(result).not.toHaveProperty('is_owner');
    expect(result).not.toHaveProperty('host_meta');
  });

  it('drops is_owner/host_meta when the record the library read is unknown', async () => {
    // A resolver that never reads the record through its client: the service
    // can't tell the record is an NFT, so it treats it as not one.
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'https://cdn.test/a.png', is_owner: true, host_meta: {} }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).not.toHaveProperty('is_owner');
    expect(result).not.toHaveProperty('host_meta');
  });

  it.each([NFT_RECORD, 'did:nft:eip155:1_erc721:0xabc_1', 'EIP155:1/ERC1155:0xabc/1'])(
    'keeps library-computed is_owner/host_meta for an NFT record (%s) while sanitizing its token metadata',
    async (record) => {
      const host_meta = { chain_id: 1, namespace: 'erc721', contract_address: '0xabc', token_id: '1' };
      const primary = readingResolver(record, {
        image: '<svg onload="alert(1)"/>',
        animation_url: 'javascript:alert(1)',
        is_owner: false,
        host_meta,
      });
      const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
      expect(result).toMatchObject({ image: IMG_URL, is_owner: false, host_meta });
      expect(result).not.toHaveProperty('animation_url');
    },
  );

  it('classifies the legacy resolver fallback by the record it read', async () => {
    const primary = readingResolver('https://cdn.test/none.json', null);
    const legacy = readingResolver(NFT_RECORD, { image: 'https://cdn.test/a.png', is_owner: true, host_meta: { token_id: '1' } });
    const result = await makeService(primary, legacy).getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toMatchObject({ is_owner: true, host_meta: { token_id: '1' } });
  });
});

// The same guarantees against the ens-avatar version the service ships with: a
// real AvatarResolver over a fake chain client (and a fake fetcher, the way the
// service can swap in its own), so the record observation is exercised through
// the library itself rather than a stand-in.
describe('AvatarService.getAvatarMeta with the real ens-avatar resolver', () => {
  const OWNER = '0x1111111111111111111111111111111111111111';
  const CONTRACT = '0x2222222222222222222222222222222222222222';
  const RECORD_URL = 'https://cdn.test/avatar.json';

  type Gate = { promise: Promise<void>; open: () => void };
  const gate = (): Gate => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };

  // Records per name, optionally held until a gate opens; token metadata for the
  // NFT on-chain (tokenURI data: JSON) and URI-record JSON behind RECORD_URL.
  function realService(opts: {
    records: Record<string, string>;
    recordGates?: Record<string, Gate>;
    tokenGate?: Gate;
    tokenMeta?: Record<string, unknown>;
    recordJson?: Record<string, unknown>;
  }): AvatarService {
    const client: ChainClient = {
      async getEnsRecord(name: string) {
        await opts.recordGates?.[name]?.promise;
        return { record: opts.records[name] ?? null, address: OWNER };
      },
      async readContract<T>({ functionName }: ReadContractParams): Promise<T> {
        if (functionName === 'ownerOf') return OWNER as T;
        await opts.tokenGate?.promise;
        const json = Buffer.from(JSON.stringify(opts.tokenMeta ?? {})).toString('base64');
        return `data:application/json;base64,${json}` as T;
      },
    };
    const fetcher: Fetcher = {
      async head() {
        return { status: 200, headers: { 'content-type': 'application/json' }, data: undefined };
      },
      async get<T>() {
        return { status: 200, headers: {}, data: (opts.recordJson ?? {}) as T };
      },
      async getArrayBuffer() {
        throw new Error('unexpected getArrayBuffer');
      },
    };
    const resolver = new AvatarResolver(client);
    resolver.fetcher = fetcher;
    const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain);
    (svc as unknown as { resolver: AvatarResolver }).resolver = resolver;
    (svc as unknown as { legacyResolver?: AvatarResolver }).legacyResolver = undefined;
    return svc;
  }

  it("strips is_owner/host_meta from a URI record's own JSON and sanitizes its fields", async () => {
    const svc = realService({
      records: { 'nick.eth': RECORD_URL },
      recordJson: {
        name: 'forged',
        image: 'https://cdn.test/a.png',
        image_data: '<svg onload="alert(1)"/>',
        external_url: 'javascript:alert(1)',
        is_owner: true,
        host_meta: { chain_id: 1, namespace: 'erc721', contract_address: CONTRACT, token_id: '1' },
      },
    });
    const result = await svc.getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({ name: 'forged', image: 'https://cdn.test/a.png', uri: 'nick.eth' });
  });

  it('keeps the library-computed is_owner/host_meta of an NFT record and sanitizes its token metadata', async () => {
    const svc = realService({
      records: { 'nick.eth': `eip155:1/erc721:${CONTRACT}/7` },
      tokenMeta: { name: 'Token #7', image: '<svg onload="alert(1)"/>', animation_url: 'vbscript:msgbox(1)' },
    });
    const result = await svc.getAvatarMeta('nick.eth', IMG_URL);
    expect(result).toEqual({
      name: 'Token #7',
      image: IMG_URL,
      is_owner: true,
      uri: 'nick.eth',
      host_meta: {
        chain_id: 1,
        namespace: 'erc721',
        contract_address: CONTRACT,
        token_id: '7',
        reference_url: `https://opensea.io/assets/${CONTRACT}/7`,
      },
    });
  });

  it.each([CID, `ipfs/${CID}/7.png`, `/ipfs/${CID}/7.png`])(
    'serves a CID-path token image (%s) as the URL the avatar endpoint resolves it to',
    async (image) => {
      const svc = realService({ records: { 'nick.eth': `eip155:1/erc721:${CONTRACT}/7` }, tokenMeta: { image } });
      const result = await svc.getAvatarMeta('nick.eth', IMG_URL);
      // The library's own image resolution (what getAvatar serves) for the same token.
      const avatarImage = utils.getImageURI({ metadata: { image } });
      expect(avatarImage).toMatch(/^https:\/\/ipfs\.io\/ipfs\//);
      expect(result).toMatchObject({ image: avatarImage, is_owner: true, host_meta: { token_id: '7' } });
    },
  );

  it('classifies concurrent lookups on the shared resolver independently', async () => {
    // nft.eth reads its record first but finishes last; uri.eth's record is read
    // in between. A record noted on shared state would misclassify one of them.
    const uriGate = gate();
    const tokenGate = gate();
    const svc = realService({
      records: { 'nft.eth': `eip155:1/erc721:${CONTRACT}/7`, 'uri.eth': RECORD_URL },
      recordGates: { 'uri.eth': uriGate },
      tokenGate,
      tokenMeta: { image: 'https://cdn.test/token.png' },
      recordJson: { image: 'https://cdn.test/a.png', is_owner: true, host_meta: { token_id: '1' } },
    });

    const nft = svc.getAvatarMeta('nft.eth', IMG_URL);
    const uri = svc.getAvatarMeta('uri.eth', IMG_URL);
    uriGate.open();
    const uriResult = await uri;
    tokenGate.open();
    const nftResult = await nft;

    expect(uriResult).not.toHaveProperty('is_owner');
    expect(uriResult).not.toHaveProperty('host_meta');
    expect(nftResult).toMatchObject({ is_owner: true, host_meta: { token_id: '7' } });
  });

  // /meta points an inline image at the avatar endpoint, on this service's
  // origin. The endpoint serves what ens-avatar resolves: an inline SVG only in
  // the library's sanitized form, so no script or handler reaches the origin,
  // and /meta points there only when the endpoint serves an image at all.
  const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>'
    + '<a href="javascript:alert(3)"><rect width="9" height="9"/></a>'
    + '<foreignObject><iframe src="javascript:alert(4)"></iframe></foreignObject></svg>';
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const INLINE: Record<string, string> = {
    'a base64 SVG data: URI': `data:image/svg+xml;base64,${b64(EVIL_SVG)}`,
    'a URL-encoded SVG data: URI': `data:image/svg+xml,${encodeURIComponent(EVIL_SVG)}`,
    'SVG markup': EVIL_SVG,
    'SVG markup with an XML declaration': `<?xml version="1.0"?>${EVIL_SVG}`,
    'an upper-case SVG data: URI': `DATA:IMAGE/SVG+XML;base64,${b64(EVIL_SVG)}`,
    'a mixed-case SVG data: URI': `Data:Image/Svg+Xml;base64,${b64(EVIL_SVG)}`,
    'an SVG data: URI with a charset': `data:image/svg+xml;charset=utf-8;base64,${b64(EVIL_SVG)}`,
    'SVG labelled as a PNG': `data:image/png;base64,${b64(EVIL_SVG)}`,
    'an SVG data: URI after whitespace': `  data:image/svg+xml;base64,${b64(EVIL_SVG)}`,
  };
  const PLACES: Record<string, (value: string) => Parameters<typeof realService>[0]> = {
    'the avatar record': (value) => ({ records: { 'nick.eth': value } }),
    'the record JSON image': (value) => ({ records: { 'nick.eth': RECORD_URL }, recordJson: { image: value } }),
    'the record JSON image_url': (value) => ({ records: { 'nick.eth': RECORD_URL }, recordJson: { image_url: value } }),
    'the record JSON image_data': (value) => ({ records: { 'nick.eth': RECORD_URL }, recordJson: { image_data: value } }),
    'NFT token metadata': (value) => ({ records: { 'nick.eth': `eip155:1/erc721:${CONTRACT}/7` }, tokenMeta: { image: value } }),
  };
  it.each(Object.keys(INLINE).flatMap((inline) => Object.keys(PLACES).map((place) => [inline, place])))(
    '%s in %s: /meta points at the avatar endpoint exactly when it serves the image, never active SVG',
    async (inline, place) => {
      const svc = realService(PLACES[place](INLINE[inline]));
      const meta = await svc.getAvatarMeta('nick.eth', IMG_URL);
      const served = await svc.getAvatarImage('nick.eth');

      expect(meta?.image === IMG_URL).toBe(served !== null);
      if (served) {
        expect(served.mimeType).toBe('image/svg+xml');
        expect(served.buffer.toString('utf8')).not.toMatch(/<script|\son\w+\s*=|javascript:|<iframe|<foreignObject/i);
      }
    },
  );
});
