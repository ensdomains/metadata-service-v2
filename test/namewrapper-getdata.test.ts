import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, type AbiFunction } from 'viem';
import { BlockchainService, CONTRACTS, ENS_REGISTRY_ABI, ENS_V2_CONTRACTS, NAME_WRAPPER_ABI } from '../src/services/blockchain';
import { ResolverService } from '../src/services/resolver';
import { namehash } from '../src/utils/ens';

// The NameWrapper's getData takes the token id (uint256). The service called
// getData(bytes32) (selector 0x54f6127f), which the contract does not have, so
// the read always reverted and a wrapped name resolved on the chain tier never
// got its owner, fuses or expiry.

// The contract's own ABI (as in @ensdomains/ensjs), not the service's.
const WRAPPER = parseAbi(['function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)']);
const RPC = 'https://mainnet.test.rpc';
const WRAPPED_OWNER = '0x4444444444444444444444444444444444444444';
const ZERO = '0x0000000000000000000000000000000000000000';
const EXPIRY = 1_900_000_000n;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NameWrapper getData', () => {
  it("calls the contract's getData(uint256)", () => {
    const getData = NAME_WRAPPER_ABI.find((f) => f.name === 'getData') as AbiFunction;
    expect(toFunctionSelector(getData)).toBe('0x0178fe3f');
  });

  it("reads a wrapped subname's owner, fuses and expiry on the chain tier", async () => {
    const name = 'sub.wrapped.eth';
    const node = namehash(name);
    const answered: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { id, params: [{ to, data }] } = JSON.parse(String(init?.body));
      const reply = (result: `0x${string}`) => Response.json({ jsonrpc: '2.0', id, result });
      // A v1 name: AVAILABLE (all-zero state) in the v2 .eth registry.
      if (to.toLowerCase() === ENS_V2_CONTRACTS.mainnet.ethRegistry) return reply(`0x${'00'.repeat(160)}`);
      if (to.toLowerCase() === CONTRACTS.mainnet.registry.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: ENS_REGISTRY_ABI, data });
        answered.push(functionName);
        const result = functionName === 'owner' ? CONTRACTS.mainnet.nameWrapper : ZERO;
        return reply(encodeFunctionResult({ abi: ENS_REGISTRY_ABI, functionName, result } as never));
      }
      if (to.toLowerCase() === CONTRACTS.mainnet.nameWrapper.toLowerCase() && data.startsWith('0x0178fe3f')) {
        const { args } = decodeFunctionData({ abi: WRAPPER, data });
        expect(args[0]).toBe(BigInt(node));
        answered.push('getData');
        return reply(encodeFunctionResult({ abi: WRAPPER, functionName: 'getData', result: [WRAPPED_OWNER, 65537, EXPIRY] }));
      }
      // Anything else (e.g. getData(bytes32)) reverts, as the contract does.
      return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } });
    }));
    const resolver = new ResolverService(new BlockchainService({ MAINNET_RPC_URL: RPC, SEPOLIA_RPC_URL: RPC }));

    const data = await resolver.resolveName(name, BigInt(node).toString(), 'mainnet');

    expect(answered).toContain('getData');
    expect(data.resolver).toMatchObject({ isWrapped: true, registrant: WRAPPED_OWNER, fuses: 65537, expiry: EXPIRY });
    expect(data.expirationDate).toEqual(new Date(Number(EXPIRY) * 1000));
  });
});
