// The IPFS gateway avatar and header media are fetched through.
//
// The public ipfs.io gateway, and gateway.ipfs.io, dweb.link, w3s.link and
// nftstorage.link run by the same operators, stopped serving plain HTTP fetches
// on 2026-09-21 (https://gatewaychanges.ipfs.io): they answer 429 with "This
// IPFS gateway is switching to a service worker gateway only". ens-avatar
// resolves ipfs:// and ipns:// records to ipfs.io unless it is given another
// gateway, so every IPFS avatar failed. IPFS_GATEWAY sets the gateway (a
// dedicated gateway for production); the default is Filebase's public gateway,
// which serves any CID reachable on the network, at up to 200 requests a minute.

export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.filebase.io';

// Hosts of the retired gateways, whose links still fill NFT metadata and
// records, and cloudflare-ipfs.com / cf-ipfs.com, which redirect to ipfs.io.
const RETIRED_GATEWAY_HOSTS = [
  'ipfs.io',
  'gateway.ipfs.io',
  'dweb.link',
  'w3s.link',
  'nftstorage.link',
  'cloudflare-ipfs.com',
  'cf-ipfs.com',
];

/**
 * The gateway origin from an IPFS_GATEWAY value: an https URL on the default
 * port, reduced to its origin. Unset keeps the default; anything else is
 * ignored with a warning. Another port would never be used: ens-avatar keeps
 * only the gateway's hostname when it moves an ipfs.io link to it, and media
 * fetches allow only the scheme's default port (media-fetch.ts), so every IPFS
 * avatar would resolve to nothing.
 */
export function parseIpfsGateway(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return DEFAULT_IPFS_GATEWAY;
  try {
    const url = new URL(value.trim());
    // The URL parser drops :443, so any port still set is another one.
    if (url.protocol === 'https:' && url.port === '') return url.origin;
  } catch {
    // fall through
  }
  console.warn(`[config] ignoring IPFS_GATEWAY=${JSON.stringify(value)}: expected an https URL on the default port`);
  return DEFAULT_IPFS_GATEWAY;
}

/**
 * `url` with a retired gateway replaced by `gateway`: path-style links
 * (https://ipfs.io/ipfs/<cid>/…, …/ipns/<name>/…) and subdomain-style links
 * (https://<cid>.ipfs.dweb.link/…). Any other URL is returned unchanged.
 */
export function toLiveGatewayUrl(url: string, gateway: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url;
  const host = parsed.hostname.toLowerCase();
  const rest = `${parsed.search}${parsed.hash}`;

  if (RETIRED_GATEWAY_HOSTS.includes(host) && /^\/(ipfs|ipns)\//.test(parsed.pathname)) {
    return `${gateway}${parsed.pathname}${rest}`;
  }
  const subdomain = host.match(/^([a-z0-9-]+)\.(ipfs|ipns)\.(.+)$/);
  if (subdomain && RETIRED_GATEWAY_HOSTS.includes(subdomain[3])) {
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${gateway}/${subdomain[2]}/${subdomain[1]}${path}${rest}`;
  }
  return url;
}
