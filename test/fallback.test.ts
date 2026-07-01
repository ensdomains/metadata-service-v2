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
    const rejectingResolver = { resolveName: vi.fn(async () => { throw new Error('no resolver'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, rejectingResolver, v1);
    await expect(svc.getDomainMetadata('ghost.eth')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws UpstreamError when a tier failed upstream and nothing resolved (→ 503)', async () => {
    const v2 = { getDomain: vi.fn(async () => { throw new UpstreamError('zigens down'); }), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const v1 = { getDomain: vi.fn(async () => ({ domain: null })), getMigrationStatus: vi.fn(), getHierarchy: vi.fn() } as any;
    const rejectingResolver = { resolveName: vi.fn(async () => { throw new Error('rpc down'); }) } as any;
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2, {} as any, rejectingResolver, v1);
    await expect(svc.getDomainMetadata('x.eth')).rejects.toBeInstanceOf(UpstreamError);
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
