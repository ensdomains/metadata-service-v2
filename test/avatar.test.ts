import { describe, it, expect, vi } from 'vitest';
import { HttpRequestError } from 'viem';
import { AvatarService } from '../src/services/avatar';
import { UpstreamError } from '../src/services/errors';
import { NETWORKS } from '../src/config/networks';

// A minimal stand-in for @ensdomains/ens-avatar's AvatarResolver — only
// getMetadata is exercised by getAvatarMeta.
type FakeResolver = { getMetadata: ReturnType<typeof vi.fn> };

// Build a real AvatarService, then swap in fake resolvers so no RPC/network is
// touched (the constructor only wires viem/ens-avatar lazily; nothing fires until
// a resolver method is called).
function makeService(primary: FakeResolver, legacy?: FakeResolver): AvatarService {
  const svc = new AvatarService('https://rpc.invalid', NETWORKS.mainnet.chain);
  (svc as unknown as { resolver: FakeResolver }).resolver = primary;
  (svc as unknown as { legacyResolver?: FakeResolver }).legacyResolver = legacy;
  return svc;
}

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
    const primary = { getMetadata: vi.fn().mockResolvedValue(meta) };
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
    const primary = { getMetadata: vi.fn().mockResolvedValue({ uri: 'nick.eth', image: 'ipfs://QmHash/pic.png' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://ipfs.io/ipfs/QmHash/pic.png');
  });

  it('rewrites the ipfs://ipfs/ prefix form', async () => {
    const primary = { getMetadata: vi.fn().mockResolvedValue({ image: 'ipfs://ipfs/QmHash' }) };
    const result = await makeService(primary).getAvatarMeta('nick.eth', IMG_URL);
    expect(result?.image).toBe('https://ipfs.io/ipfs/QmHash');
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
    expect(result?.image_data).toBe('<svg/>'); // original inline data preserved
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
