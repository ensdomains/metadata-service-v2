import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeAbiParameters, encodeErrorResult, parseAbi, toFunctionSelector } from 'viem';
import { BlockchainService, ENS_V2_CONTRACTS } from '../src/services/blockchain';
import { ResolverService } from '../src/services/resolver';
import { namehash } from '../src/utils/ens';

// WEB-1552 (R1): the blockchain fallback tier read addr, ten text records and
// contenthash from the name's resolver for every name, although no caller uses
// them. The resolver is a contract the name's owner chooses, so those reads were
// owner-controlled work: each failing read was repeated on every fallback RPC
// client, and a revert with OffchainLookup sent the service to a gateway URL of
// the owner's choosing.

const ENV = { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' };
const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const RESOLVER = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';
const EXPIRY = 2_000_000_000n;

const SELECTORS: Record<string, string> = Object.fromEntries(
  ['owner(bytes32)', 'resolver(bytes32)', 'nameExpires(uint256)', 'addr(bytes32)', 'text(bytes32,string)', 'contenthash(bytes32)'].map(
    (sig) => [toFunctionSelector(`function ${sig}`), sig.slice(0, sig.indexOf('('))],
  ),
);

const offchainLookup = encodeErrorResult({
  abi: parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)']),
  errorName: 'OffchainLookup',
  args: [RESOLVER, ['https://gateway.attacker.example/{sender}/{data}.json'], '0x01', '0x12345678', '0x'],
});

function stubNetwork() {
  const rpcCalls: string[] = [];
  const otherRequests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(ENV.MAINNET_RPC_URL)) {
      otherRequests.push(url);
      return new Response('0x', { headers: { 'content-type': 'text/plain' } });
    }
    const body = JSON.parse(String(init?.body));
    const answer = (req: { id: number; params: [{ to: string; data: string }] }) => {
      const { to, data } = req.params[0];
      // The UR proxy serves v2 (root → .eth registry), and the name is a v1
      // name: AVAILABLE (all-zero state) in the v2 .eth registry.
      const v2 = ENS_V2_CONTRACTS.mainnet;
      if (to.toLowerCase() === v2.universalResolver.toLowerCase()) return { jsonrpc: '2.0', id: req.id, result: encodeAbiParameters([{ type: 'address' }], [v2.rootRegistry as `0x${string}`]) };
      if (to.toLowerCase() === v2.rootRegistry) return { jsonrpc: '2.0', id: req.id, result: encodeAbiParameters([{ type: 'address' }], [v2.ethRegistry as `0x${string}`]) };
      if (to.toLowerCase() === v2.ethRegistry) return { jsonrpc: '2.0', id: req.id, result: `0x${'00'.repeat(160)}` };
      const fn = SELECTORS[data.slice(0, 10)] ?? data.slice(0, 10);
      rpcCalls.push(fn);
      // The owner's resolver answers every record read with an OffchainLookup
      // revert (its CCIP callback, selector 0x12345678, returns nothing).
      if (to.toLowerCase() === RESOLVER && !data.startsWith('0x12345678')) return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data: offchainLookup } };
      const result =
        fn === 'owner' ? encodeAbiParameters([{ type: 'address' }], [OWNER])
        : fn === 'resolver' ? encodeAbiParameters([{ type: 'address' }], [RESOLVER])
        : fn === 'nameExpires' ? encodeAbiParameters([{ type: 'uint256' }], [EXPIRY])
        : '0x';
      return { jsonrpc: '2.0', id: req.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { headers: { 'content-type': 'application/json' } });
  }));
  return { rpcCalls, otherRequests };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ResolverService blockchain tier', () => {
  it('reads only the registry and registrar, never the owner-chosen resolver', async () => {
    const net = stubNetwork();
    const resolver = new ResolverService(new BlockchainService(ENV));
    await resolver.resolveName('vitalik.eth', namehash('vitalik.eth'), 'mainnet');
    expect(net.rpcCalls.filter((fn) => ['addr', 'text', 'contenthash'].includes(fn))).toEqual([]);
    expect(net.otherRequests).toEqual([]); // no CCIP gateway request
  });

  it('still returns every field the fallback tiers consume', async () => {
    stubNetwork();
    const resolver = new ResolverService(new BlockchainService(ENV));
    const data = await resolver.resolveName('vitalik.eth', namehash('vitalik.eth'), 'mainnet');
    expect(data.resolver.owner.toLowerCase()).toBe(OWNER);
    expect(data.resolver.resolver.toLowerCase()).toBe(RESOLVER);
    expect(data.resolver.isWrapped).toBe(false);
    expect(data.expirationDate?.getTime()).toBe(Number(EXPIRY) * 1000);
    expect(data.version).toBe('v1');
  });
});
