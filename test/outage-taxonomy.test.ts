import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataService } from '../src/services/metadata';
import { BlockchainService, CONTRACTS } from '../src/services/blockchain';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { NotFoundError, UpstreamError } from '../src/services/errors';
import { MIGRATION_STATUS } from '../src/types';

// Outage-taxonomy regression suite: a transient upstream outage (indexers down,
// RPCs exhausted) must surface as UpstreamError (→ uncached 503) — never be
// coerced into fabricated-but-cacheable 200 data, a zero/partial resolver, or a
// false 404. Each test cites the regression it pins.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

function makeKV() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

function makeSepoliaMetadataService(): MetadataService {
  return new MetadataService(
    {
      indexerV2Endpoint: 'https://zigens.test/graphql',
      indexerV2ApiVersion: 'v2',
      indexerV1Endpoint: 'https://ensnode-v1.test/subgraph',
      network: 'sepolia',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false, // no D1 binding → no stale-row rescue unless stubbed
    },
    makeKV(),
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// getMigrationStatus (src/services/metadata.ts)
// ---------------------------------------------------------------------------
describe('getMigrationStatus outage taxonomy', () => {
  type Stubbable = {
    fallback: { getMigrationStatus: ReturnType<typeof vi.fn> };
    d1?: { getMigrationStatus: ReturnType<typeof vi.fn> };
  };

  it('total outage with no D1 row rejects with UpstreamError, never a fabricated "unmigrated"', async () => {
    // regression: a total outage used to resolve to a cacheable {status:"unmigrated"} 200
    const svc = makeSepoliaMetadataService();
    const outage = new UpstreamError(
      'All sources failed for getMigrationStatus: v2 breaker open; v1 subgraph 502; RPCs exhausted',
    );
    (svc as unknown as Stubbable).fallback = {
      getMigrationStatus: vi.fn().mockRejectedValue(outage),
    };
    // sanity: no D1 last-resort available
    expect((svc as unknown as Stubbable).d1).toBeFalsy();

    await expect(svc.getMigrationStatus('fox.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('clean miss (NotFoundError) propagates so the route can 404, not fabricate a 200', async () => {
    // regression: NotFoundError was also swallowed into the fabricated unmigrated response
    const svc = makeSepoliaMetadataService();
    (svc as unknown as Stubbable).fallback = {
      getMigrationStatus: vi.fn().mockRejectedValue(new NotFoundError('not found in any source')),
    };

    await expect(svc.getMigrationStatus('missing.eth')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('control: a stale D1 row still rescues an outage before any rethrow', async () => {
    // pins the D1 last-resort tier the fix must not break (stale data beats a 503)
    const svc = makeSepoliaMetadataService();
    (svc as unknown as Stubbable).fallback = {
      getMigrationStatus: vi.fn().mockRejectedValue(new UpstreamError('total outage')),
    };
    (svc as unknown as Stubbable).d1 = {
      getMigrationStatus: vi.fn().mockResolvedValue({
        name: 'fox.eth',
        status: MIGRATION_STATUS.NATIVE,
        owner: OWNER,
        expiration_date: '2027-01-01T00:00:00.000Z',
      }),
    };

    const res = await svc.getMigrationStatus('fox.eth');
    expect(res).toEqual({
      name: 'fox.eth',
      status: MIGRATION_STATUS.NATIVE,
      owner: OWNER,
      expirationDate: '2027-01-01T00:00:00.000Z',
    });
  });

  it('control: an unexpected internal error (no upstream verdict) still degrades to the legacy unmigrated default', async () => {
    // pins the boundary of the fix: only the NotFound/Upstream taxonomy rethrows
    const svc = makeSepoliaMetadataService();
    (svc as unknown as Stubbable).fallback = {
      getMigrationStatus: vi.fn().mockRejectedValue(new TypeError('cannot read x of undefined')),
    };

    const res = await svc.getMigrationStatus('fox.eth');
    expect(res).toEqual({ name: 'fox.eth', status: MIGRATION_STATUS.UNMIGRATED });
  });
});

// ---------------------------------------------------------------------------
// getRegistryHierarchy blockchain tier (src/services/fallback.ts)
// ---------------------------------------------------------------------------
describe('getRegistryHierarchy blockchain tier outage taxonomy', () => {
  function makeIndexerFailingWith(error: () => Error) {
    return {
      getDomain: vi.fn(async () => { throw error(); }),
      getMigrationStatus: vi.fn(async () => { throw error(); }),
      getHierarchy: vi.fn(async () => { throw error(); }),
    } as never;
  }

  function makeFallbackService(
    indexerError: () => Error,
    resolveName: ReturnType<typeof vi.fn>,
  ): { svc: FallbackService; v2: { getHierarchy: ReturnType<typeof vi.fn> }; v1: { getHierarchy: ReturnType<typeof vi.fn> } } {
    const v2 = makeIndexerFailingWith(indexerError);
    const v1 = makeIndexerFailingWith(indexerError);
    const resolver = { resolveName } as never;
    const blockchain = {} as never; // not touched by getRegistryHierarchy
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, blockchain, resolver, v1);
    return { svc, v2, v1 };
  }

  it('total outage (both indexers + all RPCs down) throws UpstreamError, never an all-zero hierarchy', async () => {
    // regression: resolve failures fabricated zero-owner placeholder levels → cacheable 200 of made-up data
    const resolveName = vi.fn(async () => {
      throw new UpstreamError('All RPC clients failed for mainnet');
    });
    const { svc, v2, v1 } = makeFallbackService(() => new UpstreamError('indexer unreachable'), resolveName);

    await expect(svc.getRegistryHierarchy('foo.eth')).rejects.toBeInstanceOf(UpstreamError);

    // Sanity: every tier really was attempted and failed upstream.
    expect(v2.getHierarchy).toHaveBeenCalled();
    expect(v1.getHierarchy).toHaveBeenCalled();
    expect(resolveName).toHaveBeenCalled();
  });

  it('control: only ANCESTOR levels may degrade to placeholders; the requested name keeps its real data', async () => {
    // pins the fix boundary: ancestor placeholder degradation survives, but is never applied to the leaf
    const resolveName = vi.fn(async (domainName: string) => {
      if (domainName === 'eth') throw new Error('no registry record for ancestor'); // non-upstream ancestor failure
      return { resolver: { owner: OWNER, resolver: '0xresolver' } };
    });
    const { svc } = makeFallbackService(() => new NotFoundError('not in index'), resolveName);

    const result = await svc.getRegistryHierarchy('foo.eth');
    expect(result.source).toBe('blockchain');
    const data = result.data as { name: string; ownerId?: string; parent?: { name: string; ownerId?: string } };
    expect(data.name).toBe('foo.eth');
    expect(data.ownerId).toBe(OWNER); // requested name: real data, no placeholder
    expect(data.parent?.name).toBe('eth');
    expect(data.parent?.ownerId).toBe(ZERO); // ancestor degraded to placeholder
  });

  it('control: a clean miss on the requested name itself surfaces as NotFoundError (404), not fabricated data', async () => {
    // pins the i===0 rethrow: the leaf's own verdict must propagate through the taxonomy
    const resolveName = vi.fn(async (domainName: string) => {
      if (domainName === 'foo.eth') throw new NotFoundError('foo.eth not registered');
      return { resolver: { owner: OWNER, resolver: '0xresolver' } };
    });
    const { svc } = makeFallbackService(() => new NotFoundError('not in index'), resolveName);

    await expect(svc.getRegistryHierarchy('foo.eth')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getResolverHierarchical / getV2NameRecord (src/services/blockchain.ts)
// ---------------------------------------------------------------------------
describe('getResolverHierarchical RPC-failure error contract', () => {
  const REGISTRIES = {
    root: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    eth: '0x2222222222222222222222222222222222222222' as `0x${string}`,
  };

  function makeBlockchainService(): BlockchainService {
    return new BlockchainService({
      MAINNET_RPC_URL: 'http://127.0.0.1:1',
      SEPOLIA_RPC_URL: 'http://127.0.0.1:1',
    });
  }

  const rpcExhausted = () =>
    new Error('All RPC clients failed for sepolia. Last error: fetch failed');

  it('first-label RPC exhaustion throws UpstreamError instead of returning 0x0', async () => {
    // regression: catch→break coerced a total RPC outage into resolver=0x0
    const svc = makeBlockchainService();
    vi.spyOn(svc, 'getV2Registries').mockResolvedValue(REGISTRIES);
    // Every executeWithFallback call = all clients exhausted (flaky RPC).
    vi.spyOn(svc, 'executeWithFallback').mockRejectedValue(rpcExhausted());

    await expect(svc.getResolverHierarchical('sepolia', 'foo.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('mid-walk RPC exhaustion throws UpstreamError instead of a stale parent resolver', async () => {
    // regression: mid-walk failure returned the parent label's resolver as if final
    const svc = makeBlockchainService();
    vi.spyOn(svc, 'getV2Registries').mockResolvedValue(REGISTRIES);
    const PARENT_RESOLVER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    let call = 0;
    vi.spyOn(svc, 'executeWithFallback').mockImplementation(async () => {
      call++;
      if (call === 1) {
        // label 'eth' on root registry succeeds: has a resolver + a subregistry
        return { result: { subregistry: REGISTRIES.eth, resolver: PARENT_RESOLVER }, usedFallback: false } as never;
      }
      throw rpcExhausted(); // label 'foo' on eth registry: all clients exhausted
    });

    await expect(svc.getResolverHierarchical('sepolia', 'foo.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('getV2NameRecord for a v2-REGISTERED 2LD with flaky RPC throws UpstreamError, not resolver=0x0', async () => {
    // regression: a v2-registered name was served with a fabricated zero resolver during an RPC outage
    const svc = makeBlockchainService();
    vi.spyOn(svc, 'getV2Registries').mockResolvedValue(REGISTRIES);
    // ETHRegistry reads succeeded earlier: name is REGISTERED(2) on v2.
    vi.spyOn(svc, 'getV2Registration').mockResolvedValue({
      status: 2,
      expiry: 1893456000n,
      owner: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    vi.spyOn(svc, 'isUnmigratedName').mockResolvedValue(false);
    // From here the RPC turns flaky: UR findResolver AND the hierarchical walk
    // both exhaust all clients.
    vi.spyOn(svc, 'executeWithFallback').mockRejectedValue(rpcExhausted());

    await expect(svc.getV2NameRecord('sepolia', 'foo.eth')).rejects.toBeInstanceOf(UpstreamError);
  });
});

// ---------------------------------------------------------------------------
// resolveTokenId (src/services/metadata.ts)
// ---------------------------------------------------------------------------
describe('resolveTokenId under a primary (v2) indexer outage', () => {
  // tokenId = labelhash("nick") as decimal — a plain v1 BaseRegistrar token
  const NICK_TOKEN_ID =
    '79233663829379634837589865448569342784712482819484549289560981379859480642508';

  function makeService() {
    const service = makeSepoliaMetadataService();

    // Simulate a zigens outage: the primary (v2) indexer's namehash lookup fails
    // with an UpstreamError, exactly as IndexerService.executeQuery throws when
    // the endpoint is down/times out.
    const v2Spy = vi
      .fn()
      .mockRejectedValue(new UpstreamError('ensnode request failed: fetch failed (zigens down)'));
    (service.indexerV2 as unknown as { getDomainByNamehash: unknown }).getDomainByNamehash = v2Spy;

    // The healthy v1 ENSNode subgraph CAN answer this namehash lookup.
    const v1Spy = vi
      .fn()
      .mockResolvedValue({ domain: { name: 'nick.eth', labelName: 'nick' }, usedFallback: false });
    const indexerV1 = (service as unknown as { indexerV1?: { getDomainByNamehash: unknown } }).indexerV1;
    if (!indexerV1) throw new Error('indexerV1 was not constructed — config wiring wrong');
    indexerV1.getDomainByNamehash = v1Spy;

    return { service, v2Spy, v1Spy };
  }

  it('BaseRegistrar tokenId: falls through to the healthy v1 subgraph and resolves', async () => {
    // regression: the primary UpstreamError aborted resolution before the v1 tier was consulted (503 instead of the answer)
    const { service, v2Spy, v1Spy } = makeService();

    const res = await service.resolveTokenId('sepolia', CONTRACTS.sepolia.registrar, NICK_TOKEN_ID);

    expect(res.name).toBe('nick.eth');
    expect(res.registryType).toBe('registry');
    expect(v2Spy).toHaveBeenCalledTimes(1);
    expect(v1Spy).toHaveBeenCalledTimes(1);
  });

  it('NameWrapper tokenId: same fall-through to v1', async () => {
    // regression: NameWrapper (namehash-form) lookups aborted on the same primary outage
    const { service, v1Spy } = makeService();
    v1Spy.mockResolvedValue({ domain: { name: 'vitalik.eth' }, usedFallback: false });
    const namehashDecimal =
      '28830309785498705498605967065639339498816498484392297776506587544614029665578';

    const res = await service.resolveTokenId('sepolia', CONTRACTS.sepolia.nameWrapper, namehashDecimal);

    expect(res.name).toBe('vitalik.eth');
    expect(res.registryType).toBe('namewrapper');
    expect(v1Spy).toHaveBeenCalledTimes(1);
  });

  it('v1 miss after a v2 outage surfaces the ORIGINAL UpstreamError, not a cacheable 404', async () => {
    // regression companion: a v1 miss proves nothing while the v2 index was never consulted
    const { service, v1Spy } = makeService();
    v1Spy.mockResolvedValue({ domain: null, usedFallback: false });

    let thrown: unknown;
    try {
      await service.resolveTokenId('sepolia', CONTRACTS.sepolia.registrar, NICK_TOKEN_ID);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UpstreamError);
    expect((thrown as Error).message).toContain('zigens down'); // the original outage error, verbatim
    expect(thrown).not.toBeInstanceOf(NotFoundError);
  });

  it('control: a clean miss on v2 also falls through to v1 (non-outage path unchanged)', async () => {
    const { service, v2Spy, v1Spy } = makeService();
    v2Spy.mockResolvedValue({ domain: null, usedFallback: false });

    const res = await service.resolveTokenId('sepolia', CONTRACTS.sepolia.registrar, NICK_TOKEN_ID);
    expect(res.name).toBe('nick.eth');
    expect(v1Spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ResolverService error-taxonomy passthrough (src/services/resolver.ts)
// ---------------------------------------------------------------------------
describe('ResolverService error-taxonomy passthrough', () => {
  it('resolveName lets UpstreamError through unchanged (fallback tiers rely on instanceof)', async () => {
    // regression: resolveName wrapped EVERY error in a plain Error, so the
    // registry-hierarchy tier's UpstreamError guard was dead code and partial
    // outages fabricated zero-owner levels into a cacheable 200.
    const { ResolverService } = await import('../src/services/resolver');
    const svc = new ResolverService({} as never);
    const outage = new UpstreamError('all RPC clients failed');
    vi.spyOn(svc as unknown as { resolveFromNetwork: () => Promise<never> }, 'resolveFromNetwork')
      .mockRejectedValue(outage);
    await expect(svc.resolveName('foo.eth', '0x0', 'sepolia')).rejects.toBe(outage);
  });

  it('resolveName lets NotFoundError through unchanged (clean miss → 404, not generic failure)', async () => {
    const { ResolverService } = await import('../src/services/resolver');
    const svc = new ResolverService({} as never);
    const miss = new NotFoundError('foo.eth is not registered');
    vi.spyOn(svc as unknown as { resolveFromNetwork: () => Promise<never> }, 'resolveFromNetwork')
      .mockRejectedValue(miss);
    await expect(svc.resolveName('foo.eth', '0x0', 'sepolia')).rejects.toBe(miss);
  });

  it('control: other errors still wrap into the generic "Unable to resolve" Error', async () => {
    const { ResolverService } = await import('../src/services/resolver');
    const svc = new ResolverService({} as never);
    vi.spyOn(svc as unknown as { resolveFromNetwork: () => Promise<never> }, 'resolveFromNetwork')
      .mockRejectedValue(new TypeError('boom'));
    await expect(svc.resolveName('foo.eth', '0x0', 'sepolia')).rejects.toThrow(/Unable to resolve foo\.eth/);
  });
});

// ---------------------------------------------------------------------------
// resolveStatusForImage strict mode (src/services/metadata.ts) — webhook guard
// ---------------------------------------------------------------------------
describe('resolveStatusForImage strict mode (webhook persistence guard)', () => {
  function makeDegradedCorroborationService(): MetadataService {
    // indexerV1-sourced record with v2Consulted=false → statusFromSource must
    // corroborate on-chain; the chain read fails (RPCs exhausted).
    const svc = makeSepoliaMetadataService();
    (svc as unknown as { fallback: unknown }).fallback = {
      getDomainMetadata: vi.fn().mockResolvedValue({
        data: { name: 'fox.eth', ownerId: OWNER, owner: { id: OWNER } },
        source: 'indexerV1',
        usedFallback: true,
        retries: 1,
        v2Consulted: false,
      }),
    };
    vi.spyOn(BlockchainService.prototype, 'isUnmigratedName')
      .mockRejectedValue(new UpstreamError('v2 migration check failed: RPCs exhausted'));
    return svc;
  }

  it('non-strict (badge rendering): degrades to the safe unmigrated default', async () => {
    const svc = makeDegradedCorroborationService();
    await expect(svc.resolveStatusForImage('sepolia', 'fox.eth')).resolves.toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('strict (webhook → D1 persistence): rejects with UpstreamError instead of a degraded default', async () => {
    // regression: the webhook warming path persisted the degraded "unmigrated"
    // to D1 during a zigens+RPC outage, clobbering a correct native/migrated row.
    const svc = makeDegradedCorroborationService();
    await expect(svc.resolveStatusForImage('sepolia', 'fox.eth', { strict: true }))
      .rejects.toBeInstanceOf(UpstreamError);
  });
});
