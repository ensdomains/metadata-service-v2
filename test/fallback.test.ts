import { describe, it, expect, vi } from 'vitest';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { NotFoundError, UpstreamError } from '../src/services/errors';

// Minimal doubles for the services FallbackService orchestrates. Only the methods
// the tested operations touch are implemented.

function makeIndexer(domain: any) {
  return {
    getDomain: vi.fn(async () => ({ domain })),
    getMigrationStatus: vi.fn(async () => ({ status: domain })),
    getHierarchy: vi.fn(async () => ({ hierarchy: domain })),
  } as any;
}

function makeResolver() {
  return {
    resolveName: vi.fn(async (name: string) => ({
      name,
      resolver: { owner: '0xowner', resolver: '0xresolver', registrant: '0xreg' },
      expirationDate: undefined,
      registrationDate: undefined,
      migrationStatus: 'unmigrated',
    })),
  } as any;
}

const blockchain = {} as any; // unused by the indexer paths

function makeService(domain: any) {
  const indexer = makeIndexer(domain);
  const resolver = makeResolver();
  const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, blockchain, resolver);
  return { svc, indexer, resolver };
}

describe('FallbackService — indexer → blockchain chain', () => {
  it('uses the indexer when it has the name', async () => {
    const { svc, resolver } = makeService({ name: 'fox.eth', isMigrated: false });
    const res = await svc.getDomainMetadata('fox.eth');
    expect(res.source).toBe('indexerV2');
    expect(res.usedFallback).toBe(false);
    expect((res.data as any).name).toBe('fox.eth');
    expect(resolver.resolveName).not.toHaveBeenCalled();
  });

  it('falls through to blockchain when the indexer misses', async () => {
    const { svc, resolver } = makeService(null);
    const res = await svc.getDomainMetadata('nowhere.eth');
    expect(res.source).toBe('blockchain');
    expect(res.usedFallback).toBe(true);
    expect(resolver.resolveName).toHaveBeenCalledTimes(1);
  });

  it('does NOT fabricate metadata for an unregistered name (empty registry owner → not found)', async () => {
    // the indexer misses, and the on-chain resolver returns synthetic empty data
    // (zero owner) for a never-registered name → must surface as not-found, not 200.
    const unregistered = {
      resolveName: vi.fn(async (name: string) => ({
        name,
        resolver: { owner: '0x0000000000000000000000000000000000000000', resolver: '', registrant: undefined },
        expirationDate: undefined, registrationDate: undefined, migrationStatus: 'unmigrated',
      })),
    } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, makeIndexer(null), blockchain, unregistered);
    await expect(svc.getDomainMetadata('blabl4a.eth')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('applies the same chain to migration status', async () => {
    const { svc, indexer } = makeService({ name: 'old.eth', isMigrated: false });
    const res = await svc.getMigrationStatus('old.eth');
    expect(res.source).toBe('indexerV2');
    expect(indexer.getMigrationStatus).toHaveBeenCalledTimes(1);
  });
});

describe('FallbackService — circuit-breaker only trips on upstream failures (C1)', () => {
  it('a NotFound miss does NOT trip the breaker — the indexer is still tried on the next request', async () => {
    const indexer = {
      getDomain: vi.fn()
        .mockResolvedValueOnce({ domain: null })                                  // miss → NotFound
        .mockResolvedValueOnce({ domain: { name: 'fox.eth', isMigrated: false } }), // would hit
      getMigrationStatus: vi.fn(), getHierarchy: vi.fn(),
    } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, {} as any, makeResolver());

    const r1 = await svc.getDomainMetadata('fox.eth');
    expect(r1.source).toBe('blockchain');             // missed the indexer, fell to the chain
    const r2 = await svc.getDomainMetadata('fox.eth');
    expect(r2.source).toBe('indexerV2');              // not skipped → served it
    expect(indexer.getDomain).toHaveBeenCalledTimes(2); // breaker stayed closed
  });

  it('throws a definitive NotFoundError when every tier cleanly misses (→ 404)', async () => {
    // A CLEAN chain-tier miss = resolveName succeeds but the name has no owner in
    // any registry (v1 or v2) → the tier maps that to NotFoundError. (A resolver
    // that THROWS is an RPC failure — that's the UpstreamError case below.)
    const emptyResolver = { resolveName: vi.fn(async (name: string) => ({
      name,
      resolver: { owner: '0x0000000000000000000000000000000000000000', resolver: '0x0000000000000000000000000000000000000000' },
      migrationStatus: 'unmigrated',
    })) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, makeIndexer(null), {} as any, emptyResolver);
    const error = await svc.getDomainMetadata('ghost.eth').catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.definitive).toBe(true);
  });

  it('throws UpstreamError when the indexer misses and the chain tier CANNOT be read (→ 503, not a cacheable 404)', async () => {
    const rejectingResolver = { resolveName: vi.fn(async () => { throw new Error('all RPCs failed'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, makeIndexer(null), {} as any, rejectingResolver);
    await expect(svc.getDomainMetadata('ghost.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('throws UpstreamError when the indexer failed upstream and nothing resolved (→ 503)', async () => {
    const indexer = { getDomain: vi.fn(async () => { throw new UpstreamError('bigname down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const rejectingResolver = { resolveName: vi.fn(async () => { throw new Error('rpc down'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, {} as any, rejectingResolver);
    await expect(svc.getDomainMetadata('x.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('serves a native v2 name from the CHAIN tier when the indexer misses (v2-aware existence)', async () => {
    // A name born on v2 has NO v1 registry owner. The v2-aware resolver returns
    // its v2 owner, so the chain tier must serve it instead of 404ing.
    const v2Resolver = { resolveName: vi.fn(async (name: string) => ({
      name,
      resolver: { owner: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809', resolver: '0x2245606dd6b3ae61205fcf8c843e200cc2f1123d' },
      migrationStatus: 'migrated', // on-chain view: on v2 (never 'native')
      expirationDate: new Date('2028-09-28T00:00:00Z'),
    })) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, makeIndexer(null), {} as any, v2Resolver);

    const res = await svc.getDomainMetadata('fox.eth');
    expect(res.source).toBe('blockchain');
    expect((res.data as any).owner.id).toBe('0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809');
    expect((res.data as any).chainMigrationStatus).toBe('migrated');
    expect(res.v2Consulted).toBe(true); // the indexer ran (clean miss)
  });

  it('marks v2Consulted=false while the breaker is open', async () => {
    const indexer = { getDomain: vi.fn(async () => { throw new UpstreamError('bigname down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, {} as any, makeResolver());

    // 1st call: the indexer errors upstream (breaker opens) → served by the chain
    const r1 = await svc.getDomainMetadata('moved.eth');
    expect(r1.source).toBe('blockchain');
    expect(r1.v2Consulted).toBe(false);

    // 2nd call: breaker open → indexer skipped entirely → still not consulted
    const r2 = await svc.getDomainMetadata('moved.eth');
    expect(r2.source).toBe('blockchain');
    expect(r2.v2Consulted).toBe(false);
    expect(indexer.getDomain).toHaveBeenCalledTimes(1); // skipped on the 2nd call
  });

  it('an UpstreamError trips the breaker — the indexer is skipped during cooldown', async () => {
    const indexer = {
      getDomain: vi.fn()
        .mockRejectedValueOnce(new UpstreamError('bigname down'))                  // fail → trip
        .mockResolvedValueOnce({ domain: { name: 'fox.eth', isMigrated: false } }), // would hit, but skipped
      getMigrationStatus: vi.fn(), getHierarchy: vi.fn(),
    } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, {} as any, makeResolver());

    const r1 = await svc.getDomainMetadata('fox.eth');
    expect(r1.source).toBe('blockchain');            // upstream failure → fell to the chain
    const r2 = await svc.getDomainMetadata('fox.eth');
    expect(r2.source).toBe('blockchain');            // breaker open → indexer skipped
    expect(indexer.getDomain).toHaveBeenCalledTimes(1); // second request never touched it
  });
});

describe('FallbackService — fallthroughs counts tiers tried before the answering one', () => {
  it('counts each tier that missed before the one that answered', async () => {
    expect((await makeService({ name: 'fox.eth' }).svc.getDomainMetadata('fox.eth')).fallthroughs).toBe(0);
    expect((await makeService(null).svc.getDomainMetadata('chain.eth')).fallthroughs).toBe(1);
  });

  it('counts an upstream failure, but not a tier skipped by the open breaker', async () => {
    const indexer = { getDomain: vi.fn(async () => { throw new UpstreamError('bigname down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer, blockchain, makeResolver());

    expect((await svc.getDomainMetadata('fox.eth')).fallthroughs).toBe(1); // indexer failed → chain
    expect((await svc.getDomainMetadata('fox.eth')).fallthroughs).toBe(0); // indexer skipped → chain
  });
});
