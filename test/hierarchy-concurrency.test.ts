import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FallbackService, DEFAULT_FALLBACK_CONFIG, HIERARCHY_RESOLVE_CONCURRENCY } from '../src/services/fallback';
import { CONTRACTS } from '../src/services/blockchain';
import { NotFoundError, UpstreamError } from '../src/services/errors';
import { MAX_NAME_LABELS, namehash } from '../src/utils/ens';

// WEB-1552: the registry-hierarchy blockchain tier resolved a name's levels one
// after another, so a deep name cost one full RPC round-trip per label. It now
// resolves up to HIERARCHY_RESOLVE_CONCURRENCY levels at a time, keeping the
// output order and error semantics of the sequential walk (an UpstreamError on
// any level rethrows, the requested name's own failure rethrows, an ancestor's
// other failures become placeholders).

const ZERO = '0x0000000000000000000000000000000000000000';
const DEFAULT_RESOLVER = CONTRACTS[DEFAULT_FALLBACK_CONFIG.blockchain.preferredNetwork].resolver;
const ownerOf = (domainName: string) => `owner:${domainName}`;

// A name with `labels` labels, ending in .eth.
function deepName(labels: number): string {
  return [...Array.from({ length: labels - 1 }, (_, i) => `l${i}`), 'eth'].join('.');
}

// The name's levels, TLD first ("eth", "lN.eth", ..., the name itself).
function levelsOf(name: string): string[] {
  const parts = name.split('.');
  return parts.map((_, k) => parts.slice(parts.length - 1 - k).join('.'));
}

// A resolveName stub that records call/settle order and peak concurrency. Each
// level waits `delayMs` then resolves, or throws `error` when one is given.
function makeResolver(behave: (domainName: string) => { delayMs: number; error?: Error }) {
  const state = { inFlight: 0, maxInFlight: 0, started: [] as string[], settled: [] as string[] };
  const resolveName = vi.fn(async (domainName: string) => {
    state.started.push(domainName);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const { delayMs, error } = behave(domainName);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state.inFlight--;
    state.settled.push(domainName);
    if (error) throw error;
    return { resolver: { owner: ownerOf(domainName), resolver: '0xresolver' } };
  });
  return { resolveName, state };
}

// Both indexers cleanly miss, so every request lands on the blockchain tier.
function makeService(resolveName: ReturnType<typeof vi.fn>): FallbackService {
  const miss = async () => { throw new NotFoundError('not in index'); };
  const indexer = () => ({ getDomain: vi.fn(miss), getMigrationStatus: vi.fn(miss), getHierarchy: vi.fn(miss) });
  return new FallbackService(DEFAULT_FALLBACK_CONFIG, indexer() as never, {} as never, { resolveName } as never, indexer() as never);
}

// Settles `work` on the fake clock: the levels' delays then order them the
// same way on every run (real timers drift under load, e.g. with coverage).
async function settle<T>(work: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = work.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Level = { name: string; ownerId?: string; resolverId?: string; parentId?: string; parent?: Level };

// The hierarchy as a list, the requested name first.
function flatten(level: Level | undefined): Level[] {
  const out: Level[] = [];
  for (let l = level; l; l = l.parent) out.push(l);
  return out;
}

describe('getRegistryHierarchy blockchain tier resolves levels with bounded concurrency', () => {
  it(`resolves every level once, claimed TLD first, never more than ${HIERARCHY_RESOLVE_CONCURRENCY} at a time`, async () => {
    const name = deepName(MAX_NAME_LABELS);
    const { resolveName, state } = makeResolver(() => ({ delayMs: 1 }));

    const { value: result, error } = await settle(makeService(resolveName).getRegistryHierarchy(name));
    if (!result) throw error;

    expect(result.source).toBe('blockchain');
    expect(state.started).toEqual(levelsOf(name));
    expect(state.maxInFlight).toBe(HIERARCHY_RESOLVE_CONCURRENCY);
    expect(flatten(result.data as Level)).toHaveLength(MAX_NAME_LABELS);
  });

  it('keeps the name → TLD order and ancestor placeholders when deeper levels settle first', async () => {
    const name = deepName(10);
    const levels = levelsOf(name);
    const failing = levels[4]; // an ancestor with a non-upstream failure
    // Deeper levels finish sooner, so levels settle out of claim order.
    const { resolveName, state } = makeResolver((domainName) => ({
      delayMs: (levels.length - levels.indexOf(domainName)) * 5,
      error: domainName === failing ? new Error('no registry record for ancestor') : undefined,
    }));

    const { value: result, error } = await settle(makeService(resolveName).getRegistryHierarchy(name));
    if (!result) throw error;

    expect(state.settled[0]).not.toBe('eth'); // precondition: out-of-order settling happened
    const expected = [...levels].reverse().map((level) => {
      const parent = level.split('.').slice(1).join('.');
      const owner = level === failing ? ZERO : ownerOf(level);
      return {
        name: level,
        ownerId: owner,
        resolverId: level === failing ? DEFAULT_RESOLVER : '0xresolver',
        parentId: parent ? namehash(parent) : undefined,
      };
    });
    expect(
      flatten(result.data as Level).map(({ name: n, ownerId, resolverId, parentId }) => ({ name: n, ownerId, resolverId, parentId })),
    ).toEqual(expected);
  });

  it("an ancestor's UpstreamError wins even when the requested name's own miss settles first", async () => {
    // Sequential semantics: the TLD is reached first, so its outage is the error
    // that surfaces, never the leaf's (cacheable) not-found.
    const outage = new UpstreamError('all RPC clients failed');
    const { resolveName, state } = makeResolver((domainName) =>
      domainName === 'eth'
        ? { delayMs: 20, error: outage }
        : { delayMs: 0, error: new NotFoundError(`${domainName} not registered`) },
    );

    const { error: err } = await settle(makeService(resolveName).getRegistryHierarchy('foo.eth'));

    expect(state.settled).toEqual(['foo.eth', 'eth']); // precondition: the leaf's miss settled first
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).cause).toBe(outage);
  });

  it('stops claiming new levels after an UpstreamError', async () => {
    const { resolveName } = makeResolver((domainName) =>
      domainName === 'eth' ? { delayMs: 0, error: new UpstreamError('all RPC clients failed') } : { delayMs: 10 },
    );

    expect((await settle(makeService(resolveName).getRegistryHierarchy(deepName(10)))).error).toBeInstanceOf(UpstreamError);
    // Only the levels already in flight when the TLD failed, not all ten.
    expect(resolveName).toHaveBeenCalledTimes(HIERARCHY_RESOLVE_CONCURRENCY);
  });

  it("the requested name's own clean miss still surfaces as NotFoundError", async () => {
    const name = deepName(6);
    const { resolveName, state } = makeResolver((domainName) =>
      domainName === name
        ? { delayMs: 0, error: new NotFoundError(`${name} not registered`) }
        : { delayMs: 5 },
    );

    expect((await settle(makeService(resolveName).getRegistryHierarchy(name))).error).toBeInstanceOf(NotFoundError);
    expect(state.maxInFlight).toBeGreaterThan(1); // resolved concurrently, not in turn
  });
});
