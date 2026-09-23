import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataService } from '../src/services/metadata';
import { NotFoundError, UpstreamError } from '../src/services/errors';

// Regression (WEB-1551): the D1 last-resort tier ran for every resolution error,
// including a NotFoundError that every live source agreed on, so a name that no
// longer exists was served as a 200 from whatever D1 last saw and then kept in
// the metadata cache for up to 30 days.
//
// A not-found is only definitive when the primary (v2) index actually answered.
// While the indexer circuit breaker is open that tier is skipped, and the chain
// tier alone can miss a v2-native name (e.g. registry discovery falling back to
// a stale configured registry), so D1 must still rescue that case.
//
// These tests drive the real FallbackService, ResolverService and
// BlockchainService; only the indexer transport and the RPC client are stubbed.

const ZERO = '0x0000000000000000000000000000000000000000';

type Internals = {
  indexerV2: { getDomain: (name: string) => Promise<unknown> };
  indexerV1: { getDomain: (name: string) => Promise<unknown> };
  blockchain: { executeWithFallback: (...args: unknown[]) => Promise<unknown> };
  d1: unknown;
};

function makeService(v2: 'miss' | 'down') {
  const svc = new MetadataService(
    {
      indexerV2Endpoint: 'https://indexer.test/graphql',
      indexerV2ApiVersion: 'v2',
      indexerV1Endpoint: 'https://v1.test/subgraph',
      network: 'sepolia',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
  const s = svc as unknown as Internals;
  const v2GetDomain = vi
    .spyOn(s.indexerV2, 'getDomain')
    .mockImplementation(async () => {
      if (v2 === 'down') throw new UpstreamError('zigens 502');
      return { domain: null, usedFallback: false };
    });
  vi.spyOn(s.indexerV1, 'getDomain').mockResolvedValue({ domain: null, usedFallback: false });
  // The chain has no owner for the name anywhere (v2 status AVAILABLE, no v1 owner).
  const fakeClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'ROOT_REGISTRY': throw new Error('rpc timeout');
        case 'getState': return { status: 0, expiry: 0n, latestOwner: ZERO };
        case 'getStatus': return 0;
        case 'owner':
        case 'resolver': return ZERO;
        case 'nameExpires': return 0n;
        default: throw new Error(`unexpected ${functionName}`);
      }
    },
  };
  vi.spyOn(s.blockchain, 'executeWithFallback').mockImplementation(async (_n: unknown, op: unknown) => ({
    result: await (op as (c: unknown) => Promise<unknown>)(fakeClient),
    usedFallback: false,
  }));
  const d1 = {
    getDomain: vi.fn().mockResolvedValue({
      name: 'gone.eth', labelhash: '0x01', is_migrated: true, data_source: 'ensnode',
      expiry_date: '4102444800', created_at: '1600000000',
    }),
    getMigrationStatus: vi.fn().mockResolvedValue(null),
  };
  s.d1 = d1;
  return { svc, d1, v2GetDomain };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('D1 last-resort tier vs not-found verdicts', () => {
  it('every tier, the v2 index included, cleanly misses: definitive 404, D1 not read', async () => {
    const { svc, d1 } = makeService('miss');
    const failure = await svc.getMetadata('sepolia', 'registry', 'gone.eth', 'https://meta.test').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).definitive).toBe(true);
    expect(d1.getDomain).not.toHaveBeenCalled();
  });

  it('outage (breaker closed): UpstreamError, D1 serves the stale row', async () => {
    const { svc, d1 } = makeService('down');
    const meta = await svc.getMetadata('sepolia', 'registry', 'gone.eth', 'https://meta.test');
    expect(meta.name).toBe('gone.eth');
    expect(d1.getDomain).toHaveBeenCalledTimes(1);
  });

  it('breaker open: the v2 index is skipped, the miss is not definitive, D1 still serves', async () => {
    const { svc, d1, v2GetDomain } = makeService('down');
    await svc.getMetadata('sepolia', 'registry', 'gone.eth', 'https://meta.test'); // trips the breaker
    d1.getDomain.mockClear();
    const meta = await svc.getMetadata('sepolia', 'registry', 'gone.eth', 'https://meta.test');
    expect(v2GetDomain).toHaveBeenCalledTimes(1); // skipped on the second request
    expect(meta.name).toBe('gone.eth');
    expect(d1.getDomain).toHaveBeenCalledTimes(1);
  });
});

describe('a malformed primary-index response is not a clean miss', () => {
  it.each(['{}', '{"data":null}', '{"message":"maintenance"}', '{"data":{}}', '{"data":{"domainz":null}}'])('HTTP 200 %s: the miss is not definitive, D1 still serves', async (body) => {
    const { svc, d1 } = makeService('miss');
    // Replace the stubbed v2 tier with the real indexer transport.
    vi.mocked((svc as unknown as Internals).indexerV2.getDomain).mockRestore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })));
    try {
      const meta = await svc.getMetadata('sepolia', 'registry', 'gone.eth', 'https://meta.test');
      expect(meta.name).toBe('gone.eth');
      expect(d1.getDomain).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
