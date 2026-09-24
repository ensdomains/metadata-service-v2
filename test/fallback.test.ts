import { describe, it, expect, vi } from 'vitest';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { NotFoundError, UpstreamError } from '../src/services/errors';

// Minimal doubles for the services FallbackService orchestrates. Only the methods
// the tested operations touch are implemented.

function makeEnsnode(domain: any) {
  return {
    getDomain: vi.fn(async () => ({ domain, usedFallback: false })),
    getMigrationStatus: vi.fn(async () => ({ status: domain, usedFallback: false })),
    getHierarchy: vi.fn(async () => ({ hierarchy: domain, usedFallback: false })),
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

const blockchain = {} as any; // unused by the ensnode paths

function makeService(opts: { v2: any; v1?: any }) {
  const v2 = makeEnsnode(opts.v2);
  const v1 = opts.v1 !== undefined ? makeEnsnode(opts.v1) : undefined;
  const resolver = makeResolver();
  const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, blockchain, resolver, v1);
  return { svc, v2, v1, resolver };
}

describe('FallbackService — v2 → v1 → blockchain chain', () => {
  it('uses the v2 indexer when it has the name', async () => {
    const { svc, v1, resolver } = makeService({ v2: { name: 'fox.eth', isMigrated: false }, v1: { name: 'fox.eth' } });
    const res = await svc.getDomainMetadata('fox.eth');
    expect(res.source).toBe('indexerV2');
    expect(res.usedFallback).toBe(false);
    expect((res.data as any).name).toBe('fox.eth');
    // v1 + blockchain are never consulted
    expect(v1.getDomain).not.toHaveBeenCalled();
    expect(resolver.resolveName).not.toHaveBeenCalled();
  });

  it('falls through to the v1 ENSNode indexer when the v2 indexer misses', async () => {
    // v2 returns null (name absent) → its callback throws → try v1
    const { svc, v1, resolver } = makeService({ v2: null, v1: { name: 'old.eth', isMigrated: false } });
    const res = await svc.getDomainMetadata('old.eth');
    expect(res.source).toBe('indexerV1');
    expect(res.usedFallback).toBe(true);
    expect((res.data as any).name).toBe('old.eth');
    expect(v1.getDomain).toHaveBeenCalledTimes(1);
    expect(resolver.resolveName).not.toHaveBeenCalled(); // blockchain not reached
  });

  it('falls through to blockchain when both indexers miss', async () => {
    const { svc, resolver } = makeService({ v2: null, v1: null });
    const res = await svc.getDomainMetadata('nowhere.eth');
    expect(res.source).toBe('blockchain');
    expect(res.usedFallback).toBe(true);
    expect(resolver.resolveName).toHaveBeenCalledTimes(1);
  });

  it('skips the v1 tier entirely when no v1 indexer is configured', async () => {
    // No ensnodeV1 (mainnet shape) → v2 miss goes straight to blockchain
    const { svc, resolver } = makeService({ v2: null });
    const res = await svc.getDomainMetadata('mainnet-only.eth');
    expect(res.source).toBe('blockchain');
    expect(resolver.resolveName).toHaveBeenCalledTimes(1);
  });

  it('does NOT fabricate metadata for an unregistered name (empty registry owner → not found)', async () => {
    // both indexers miss, and the on-chain resolver returns synthetic empty data
    // (zero owner) for a never-registered name → must surface as not-found, not 200.
    const v2 = makeEnsnode(null);
    const v1 = makeEnsnode(null);
    const unregistered = {
      resolveName: vi.fn(async (name: string) => ({
        name,
        resolver: { owner: '0x0000000000000000000000000000000000000000', resolver: '', registrant: undefined },
        expirationDate: undefined, registrationDate: undefined, migrationStatus: 'unmigrated',
      })),
    } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, blockchain, unregistered, v1);
    await expect(svc.getDomainMetadata('blabl4a.eth')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('applies the same chain to migration status', async () => {
    const { svc, v1 } = makeService({ v2: null, v1: { name: 'old.eth', isMigrated: false } });
    const res = await svc.getMigrationStatus('old.eth');
    expect(res.source).toBe('indexerV1');
    expect(v1.getMigrationStatus).toHaveBeenCalledTimes(1);
  });
});

describe('FallbackService — circuit-breaker only trips on upstream failures (C1)', () => {
  const resolver = () => ({
    resolveName: vi.fn(async (name: string) => ({
      name, resolver: { owner: '0xo', resolver: '0xr', registrant: '0xreg' },
      expirationDate: undefined, registrationDate: undefined, migrationStatus: 'unmigrated',
    })),
  } as any);
  const v1Hit = () => ({
    getDomain: vi.fn(async () => ({ domain: { name: 'fox.eth' } })),
    getMigrationStatus: vi.fn(async () => ({ status: { name: 'fox.eth' } })),
    getHierarchy: vi.fn(async () => ({ hierarchy: { name: 'fox.eth' } })),
  } as any);

  it('a NotFound miss does NOT trip the breaker — v2 is still tried on the next request', async () => {
    const v2 = {
      getDomain: vi.fn()
        .mockResolvedValueOnce({ domain: null })                                  // miss → NotFound
        .mockResolvedValueOnce({ domain: { name: 'fox.eth', isMigrated: false } }), // would hit
      getMigrationStatus: vi.fn(), getHierarchy: vi.fn(),
    } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, resolver(), v1Hit());

    const r1 = await svc.getDomainMetadata('fox.eth');
    expect(r1.source).toBe('indexerV1');           // missed v2, fell to v1
    const r2 = await svc.getDomainMetadata('fox.eth');
    expect(r2.source).toBe('indexerV2');             // v2 NOT skipped → served it
    expect(v2.getDomain).toHaveBeenCalledTimes(2); // breaker stayed closed
  });

  it('throws NotFoundError when every tier cleanly misses (→ 404)', async () => {
    const v2 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    // A CLEAN chain-tier miss = resolveName succeeds but the name has no owner in
    // any registry (v1 or v2) → the tier maps that to NotFoundError. (A resolver
    // that THROWS is an RPC failure — that's the UpstreamError case below.)
    const emptyResolver = { resolveName: vi.fn(async (name: string) => ({
      name,
      resolver: { owner: '0x0000000000000000000000000000000000000000', resolver: '0x0000000000000000000000000000000000000000' },
      migrationStatus: 'unmigrated',
    })) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, emptyResolver, v1);
    await expect(svc.getDomainMetadata('ghost.eth')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws UpstreamError when indexers miss and the chain tier CANNOT be read (→ 503, not a cacheable 404)', async () => {
    const v2 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const rejectingResolver = { resolveName: vi.fn(async () => { throw new Error('all RPCs failed'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, rejectingResolver, v1);
    await expect(svc.getDomainMetadata('ghost.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('throws UpstreamError when a tier failed upstream and nothing resolved (→ 503)', async () => {
    const v2 = { getDomain: vi.fn(async () => { throw new UpstreamError('zigens down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const rejectingResolver = { resolveName: vi.fn(async () => { throw new Error('rpc down'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, rejectingResolver, v1);
    await expect(svc.getDomainMetadata('x.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('serves a native v2 name from the CHAIN tier when both indexers miss (v2-aware existence)', async () => {
    // A name born on v2 has NO v1 registry owner. The v2-aware resolver returns
    // its v2 owner, so the chain tier must serve it instead of 404ing.
    const v2 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v2Resolver = { resolveName: vi.fn(async (name: string) => ({
      name,
      resolver: { owner: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809', resolver: '0x2245606dd6b3ae61205fcf8c843e200cc2f1123d' },
      migrationStatus: 'migrated', // on-chain view: on v2 (never 'native')
      expirationDate: new Date('2028-09-28T00:00:00Z'),
    })) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, v2Resolver, v1);

    const res = await svc.getDomainMetadata('fox.eth');
    expect(res.source).toBe('blockchain');
    expect((res.data as any).owner.id).toBe('0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809');
    expect((res.data as any).chainMigrationStatus).toBe('migrated');
    expect(res.v2Consulted).toBe(true); // v2 tier ran (clean miss)
  });

  it('marks v2Consulted=false while the breaker is open (v1 data is then unproven about v2)', async () => {
    const v2 = { getDomain: vi.fn(async () => { throw new UpstreamError('zigens down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: { name: 'moved.eth' } })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, makeResolver(), v1);

    // 1st call: v2 errors upstream (breaker opens) → served by v1, v2 not answered
    const r1 = await svc.getDomainMetadata('moved.eth');
    expect(r1.source).toBe('indexerV1');
    expect(r1.v2Consulted).toBe(false);

    // 2nd call: breaker open → v2 tier skipped entirely → still not consulted
    const r2 = await svc.getDomainMetadata('moved.eth');
    expect(r2.source).toBe('indexerV1');
    expect(r2.v2Consulted).toBe(false);
    expect(v2.getDomain).toHaveBeenCalledTimes(1); // skipped on the 2nd call
  });

  it('marks v2Consulted=true when the v2 tier cleanly missed before v1 served', async () => {
    const v2 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: { name: 'old.eth' } })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, makeResolver(), v1);

    const res = await svc.getDomainMetadata('old.eth');
    expect(res.source).toBe('indexerV1');
    expect(res.v2Consulted).toBe(true); // proven absent from the v2 index
  });

  it('an UpstreamError trips the breaker — v2 is skipped during cooldown', async () => {
    const v2 = {
      getDomain: vi.fn()
        .mockRejectedValueOnce(new UpstreamError('zigens down'))                  // fail → trip
        .mockResolvedValueOnce({ domain: { name: 'fox.eth', isMigrated: false } }), // would hit, but skipped
      getMigrationStatus: vi.fn(), getHierarchy: vi.fn(),
    } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, resolver(), v1Hit());

    const r1 = await svc.getDomainMetadata('fox.eth');
    expect(r1.source).toBe('indexerV1');           // upstream failure → fell to v1
    const r2 = await svc.getDomainMetadata('fox.eth');
    expect(r2.source).toBe('indexerV1');           // breaker open → v2 skipped
    expect(v2.getDomain).toHaveBeenCalledTimes(1); // second request never touched v2
  });
});

describe('FallbackService — fallthroughs counts tiers tried before the answering one', () => {
  it('counts each tier that missed before the one that answered', async () => {
    expect((await makeService({ v2: { name: 'fox.eth' } }).svc.getDomainMetadata('fox.eth')).fallthroughs).toBe(0);
    expect((await makeService({ v2: null, v1: { name: 'old.eth' } }).svc.getDomainMetadata('old.eth')).fallthroughs).toBe(1);
    expect((await makeService({ v2: null, v1: null }).svc.getDomainMetadata('chain.eth')).fallthroughs).toBe(2);
  });

  it('counts an upstream failure, but not a tier skipped by the open breaker', async () => {
    const v2 = { getDomain: vi.fn(async () => { throw new UpstreamError('zigens down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, blockchain, makeResolver(), makeEnsnode({ name: 'fox.eth' }));

    expect((await svc.getDomainMetadata('fox.eth')).fallthroughs).toBe(1); // v2 failed → v1
    expect((await svc.getDomainMetadata('fox.eth')).fallthroughs).toBe(0); // v2 skipped → v1
  });
});
