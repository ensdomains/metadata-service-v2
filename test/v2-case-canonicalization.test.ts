import { describe, it, expect, vi } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem';
import { sepolia } from 'viem/chains';
import { BlockchainService, REGISTRY_V2_ABI } from '../src/services/blockchain';
import { MetadataService, DomainExpiredError } from '../src/services/metadata';
import { labelhash } from '../src/utils/ens';

// ENS names are case-insensitive, but labelhash is not: hashing a RAW-CASE
// label queries a tokenId that does not exist on-chain. These tests pin the
// canonicalizeName-before-labelhash fixes in two places:
//   1. blockchain.ts isUnmigratedName / getV2Registration (v2 ETHRegistry reads)
//   2. metadata.ts checkExpiry (v1 BaseRegistrar 410 gate)

// ---------------------------------------------------------------------------
// Fix 1: v2 ETHRegistry reads must labelhash the canonical (lowercase) label.
//
// Simulated live sepolia ETHRegistry: fox.eth is REGISTERED(2) on v2 with a
// future expiry. The fake registry is keyed by labelhash of the canonical
// label, exactly like the real contract (which canonicalizes only over the
// tokenId version bits — masking the low byte — and can never recover case
// from a hash).
// ---------------------------------------------------------------------------

const ETH_REGISTRY = '0x1111111111111111111111111111111111111111' as const;
const ROOT_REGISTRY = '0x2222222222222222222222222222222222222222' as const;
const OWNER = '0x00000000000000000000000000000000000000A1';
const FUTURE_EXPIRY = 1856649600n; // 2028 — like real fox.eth on sepolia

// tokenId low byte is a version counter in the real PermissionedRegistry;
// getStatus/getState(anyId) canonicalize by masking it. Mirror that.
const canonicalId = (id: bigint) => id & ~0xffn;
const FOX_ID = canonicalId(BigInt(labelhash('fox'))); // registered entry

function makeFakeClient() {
  return createPublicClient({
    chain: sepolia,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
        const { to, data } = (params as [{ to: string; data: `0x${string}` }])[0];
        if (to.toLowerCase() !== ETH_REGISTRY.toLowerCase()) {
          throw new Error(`unexpected call target ${to}`);
        }
        const { functionName, args } = decodeFunctionData({ abi: REGISTRY_V2_ABI, data });
        const anyId = canonicalId(args![0] as bigint);
        const registered = anyId === FOX_ID;
        if (functionName === 'getStatus') {
          return encodeFunctionResult({
            abi: REGISTRY_V2_ABI,
            functionName: 'getStatus',
            result: registered ? 2 : 0, // REGISTERED vs AVAILABLE
          });
        }
        if (functionName === 'getState') {
          return encodeFunctionResult({
            abi: REGISTRY_V2_ABI,
            functionName: 'getState',
            result: registered
              ? { status: 2, expiry: FUTURE_EXPIRY, latestOwner: OWNER, tokenId: FOX_ID, resource: 0n }
              : { status: 0, expiry: 0n, latestOwner: '0x0000000000000000000000000000000000000000', tokenId: anyId, resource: 0n },
          });
        }
        throw new Error(`unexpected function ${String(functionName)}`);
      },
    }),
  });
}

function makeBlockchainService(): BlockchainService {
  const svc = new BlockchainService({
    MAINNET_RPC_URL: 'http://127.0.0.1:1',
    SEPOLIA_RPC_URL: 'http://127.0.0.1:1',
  });
  type Priv = {
    clients: Map<string, unknown>;
    fallbackClients: Map<string, unknown[]>;
    v2RegistryCache: Map<string, { root: string; eth: string; fetchedAt: number }>;
  };
  const priv = svc as unknown as Priv;
  // Route all sepolia RPC through the fake registry client.
  priv.clients.set('sepolia', makeFakeClient());
  priv.fallbackClients.set('sepolia', []);
  // Pre-seed registry discovery so getV2Registries doesn't hit the UR.
  priv.v2RegistryCache.set('sepolia', {
    root: ROOT_REGISTRY,
    eth: ETH_REGISTRY,
    fetchedAt: Date.now(),
  });
  return svc;
}

describe('v2 ETHRegistry reads vs request-name casing', () => {
  it('sanity: viem labelhash is case-sensitive', () => {
    expect(labelhash('Fox')).not.toBe(labelhash('fox'));
  });

  it('lowercase fox.eth is correctly seen as REGISTERED on v2', async () => {
    const svc = makeBlockchainService();
    expect(await svc.isUnmigratedName('sepolia', 'fox.eth')).toBe(false);
    const reg = await svc.getV2Registration('sepolia', 'fox.eth');
    expect(reg).not.toBeNull();
    expect(reg!.status).toBe(2);
    expect(reg!.expiry).toBe(FUTURE_EXPIRY);
  });

  it('Fox.eth (same name, mixed case) classifies identically', async () => {
    // regression: mixed-case labelhash misclassified live v2 names as unmigrated/AVAILABLE
    const svc = makeBlockchainService();
    expect(await svc.isUnmigratedName('sepolia', 'Fox.eth')).toBe(false);
    const reg = await svc.getV2Registration('sepolia', 'Fox.eth');
    expect(reg).not.toBeNull();
    expect(reg!.status).toBe(2);
    expect(reg!.expiry).toBe(FUTURE_EXPIRY);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: checkExpiry must canonicalize the name before the v1 registrar read.
//
// The blockchain layer is stubbed to behave exactly like the real v1
// BaseRegistrar: nameExpires(tokenId) is keyed by the labelhash of the
// CANONICAL (lowercase) registered label; any other tokenId is a nonexistent
// token and the real contract returns 0 for it.
// ---------------------------------------------------------------------------

const PAST = BigInt(Math.floor(Date.now() / 1000) - 24 * 3600); // expired yesterday

// "deadname.eth" was registered (lowercase, as all real registrations are)
// and its registration has lapsed.
const registrar: Record<string, bigint> = {
  [labelhash('deadname')]: PAST,
};

function makeMainnetService(): MetadataService {
  const svc = new MetadataService(
    {
      indexerV2Endpoint: 'https://indexer.test/graphql',
      network: 'mainnet',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
  (svc as unknown as { blockchain: Record<string, unknown> }).blockchain = {
    isV2Configured: vi.fn().mockReturnValue(false), // mainnet: no v2 deployment
    getV2Registration: vi.fn(),
    // Real registrar semantics: known token -> its expiry, unknown token -> 0
    getExpiry: vi.fn(async (_network: string, hash: string) => registrar[hash] ?? 0n),
  };
  return svc;
}

describe('checkExpiry 410 gate vs request-name casing', () => {
  it('control: lowercase URL deadname.eth -> DomainExpiredError (410)', async () => {
    const svc = makeMainnetService();
    await expect(svc.checkExpiry('deadname.eth')).rejects.toBeInstanceOf(DomainExpiredError);
  });

  it('mixed-case URL DeadName.eth also 410s', async () => {
    // regression: raw-case labelhash queried a nonexistent tokenId (expiry 0),
    // letting expired names bypass the 410 gate via a mixed-case URL
    const svc = makeMainnetService();
    await expect(svc.checkExpiry('DeadName.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    const getExpiry = (svc as unknown as { blockchain: { getExpiry: ReturnType<typeof vi.fn> } }).blockchain.getExpiry;
    // The registrar must have been queried with the canonical label's tokenId.
    expect(getExpiry.mock.calls[0]?.[1]).toBe(labelhash('deadname'));
  });
});
