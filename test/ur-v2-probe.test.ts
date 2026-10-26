import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import { BlockchainService, ENS_V2_CONTRACTS, REGISTRY_V2_ABI, UNIVERSAL_RESOLVER_V2_ABI } from '../src/services/blockchain';
import { namehash } from '../src/utils/ens';

// The mainnet UR proxy runs the v1 UniversalResolver until the DAO upgrades it.
// Its findResolver has the same signature but walks only the v1 registry, so a
// v2 name would silently get the wrong resolver. The service asks the proxy
// ROOT_REGISTRY() and uses it only once it answers.

const { universalResolver: UR, rootRegistry: ROOT, ethRegistry: ETH } = ENS_V2_CONTRACTS.mainnet;
const WALKED = '0x1111111111111111111111111111111111111111';
const VIA_UR = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const ABI = [...REGISTRY_V2_ABI, ...UNIVERSAL_RESOLVER_V2_ABI] as Abi;

function stubChain(urServesV2: boolean) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { id, params: [{ to, data }] } = JSON.parse(String(init?.body));
    const { functionName } = decodeFunctionData({ abi: ABI, data });
    const target = to.toLowerCase() === UR.toLowerCase() ? 'UR' : to.toLowerCase() === ROOT ? 'root' : to.toLowerCase() === ETH ? 'eth' : to;
    calls.push(`${target}.${functionName}`);
    if (target === 'UR' && (functionName !== 'ROOT_REGISTRY' || !urServesV2) && functionName !== 'findResolver') {
      return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } });
    }
    const results: Record<string, unknown> = {
      ROOT_REGISTRY: ROOT,
      getSubregistry: target === 'root' ? ETH : ZERO,
      getResolver: target === 'eth' ? WALKED : ZERO,
      getStatus: 2, // REGISTERED on v2
      findResolver: [VIA_UR, namehash('foo.eth'), 0n],
    };
    return Response.json({ jsonrpc: '2.0', id, result: encodeFunctionResult({ abi: ABI, functionName, result: results[functionName] } as never) });
  }));
  return calls;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UniversalResolver proxy v2 probe', () => {
  it('walks the configured v2 registries while the proxy does not serve v2, and probes once per TTL', async () => {
    const calls = stubChain(false);
    const svc = new BlockchainService({ MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' });

    expect(await svc.getResolverV2('mainnet', 'foo.eth')).toBe(WALKED);
    expect(await svc.getResolverV2('mainnet', 'foo.eth')).toBe(WALKED);
    expect(calls).not.toContain('UR.findResolver');
    // One probe: the revert is the answer, not retried on the fallbacks or re-asked.
    const probes = calls.filter((c) => c === 'UR.ROOT_REGISTRY').length;
    expect(probes).toBe(1);
    await svc.getResolverV2('mainnet', 'foo.eth');
    expect(calls.filter((c) => c === 'UR.ROOT_REGISTRY')).toHaveLength(probes);
  });

  it('uses the proxy once it answers ROOT_REGISTRY()', async () => {
    const calls = stubChain(true);
    const svc = new BlockchainService({ MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' });

    expect(await svc.getResolverV2('mainnet', 'foo.eth')).toBe(VIA_UR);
    expect(calls).toContain('UR.findResolver');
  });
});
