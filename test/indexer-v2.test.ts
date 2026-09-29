import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture every GraphQL request the IndexerService issues so the v2 (zigens)
// dialect's wire shape is pinned by tests: id = lowercased NAME STRING (the v1
// subgraph uses namehashes), batch filter = name_in, and the domain shape must
// request the v2 signals (protocol, tokenId, isMigrated). Schema verified live
// against graphql.ens.dev.
const requests: Array<{ document: string; variables: Record<string, unknown> }> = [];
let nextResponse: unknown = { domain: null };
// When set, every request rejects with this (ClientError-shaped for GraphQL
// errors) instead of resolving — used to simulate schema-validation failures.
let nextError: unknown = null;
// Responses for the next requests, in order, before nextResponse applies.
const queued: unknown[] = [];

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    request: vi.fn(async (opts: { document: string; variables: Record<string, unknown> }) => {
      requests.push({ document: opts.document, variables: opts.variables });
      if (nextError) throw nextError;
      return queued.length > 0 ? queued.shift() : nextResponse;
    }),
  })),
}));

import {
  IndexerService,
  REGISTRY_CACHE_MAX_ENTRIES,
  REGISTRY_KNOWN_TTL_MS,
  REGISTRY_UNKNOWN_TTL_MS,
} from '../src/services/indexer';
import { UpstreamError } from '../src/services/errors';
import { namehash } from '../src/utils/ens';

function makeV2() {
  return new IndexerService({ primaryEndpoint: 'https://zigens.test/graphql', apiVersion: 'v2' });
}

describe('IndexerService — v2 (zigens) dialect', () => {
  beforeEach(() => {
    requests.length = 0;
    queued.length = 0;
    nextResponse = { domain: null };
    nextError = null;
  });

  it('getDomain queries by lowercased name string, not namehash', async () => {
    nextResponse = { domain: { id: 'fox.eth', name: 'fox.eth' } };
    await makeV2().getDomain('FOX.eth');

    expect(requests).toHaveLength(1);
    expect(requests[0].variables).toEqual({ name: 'fox.eth' });
    expect(requests[0].document).toContain('domain(id: $name)');
  });

  it('the v2 domain query requests the v2 classification signals', async () => {
    await makeV2().getDomain('fox.eth');
    const doc = requests[0].document;
    for (const field of ['isMigrated', 'protocol', 'tokenId', 'tokenVersion', 'expiryDate']) {
      expect(doc).toContain(field);
    }
  });

  it('getDomainByNamehash passes the namehash through (zigens domain(id:) accepts name OR namehash)', async () => {
    const hash = namehash('fox.eth');
    nextResponse = { domain: { id: 'fox.eth', name: 'fox.eth' } };
    const { domain } = await makeV2().getDomainByNamehash(hash);

    expect(requests[0].variables).toEqual({ name: hash });
    expect(domain?.name).toBe('fox.eth');
  });

  it('getDomains batches via name_in with lowercased names', async () => {
    nextResponse = { domains: [] };
    await makeV2().getDomains(['Fox.eth', 'BAR.eth']);

    expect(requests[0].document).toContain('name_in: $names');
    expect(requests[0].variables).toEqual({ names: ['fox.eth', 'bar.eth'], first: 2 });
  });

  it('getMigrationStatus queries by name string and requests protocol', async () => {
    nextResponse = { domain: { name: 'fox.eth', isMigrated: false } };
    await makeV2().getMigrationStatus('fox.eth');

    expect(requests[0].variables).toEqual({ id: 'fox.eth' });
    expect(requests[0].document).toContain('protocol');
  });

  describe('getDomainByTokenId (native v2 tokenId reverse lookup)', () => {
    // The sepolia ETHRegistry; both filters are scoped to the registry asked about.
    const REGISTRY = { address: '0x657ea849311d3d5823348dded7c2aaafb3ede09e', name: 'eth' };
    // fox.eth labelhash with low 32 bits = token version 1 / canonical form
    const VERSIONED = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000001' as const;
    const CANONICAL = '0x5a95ee1dc2a184b02af4e3b4deae1b95aacbf29f651487d77e4a9b3c00000000';

    it('queries domains(where: { tokenId }) with the lowercased exact id first', async () => {
      nextResponse = { domains: [{ id: 'fox.eth', name: 'fox.eth', labelName: 'fox' }] };
      const mixedCase = ('0x' + VERSIONED.slice(2).toUpperCase()) as `0x${string}`;
      const { domain } = await makeV2().getDomainByTokenId(mixedCase, REGISTRY);

      expect(domain?.name).toBe('fox.eth');
      expect(requests).toHaveLength(1);
      expect(requests[0].document).toContain('tokenId: $id');
      expect(requests[0].variables).toEqual({ id: VERSIONED, registry: REGISTRY.address });
    });

    it('falls back to the canonicalId filter (version bits zeroed) on an exact-id miss', async () => {
      nextResponse = { domains: [] };
      await makeV2().getDomainByTokenId(VERSIONED, REGISTRY);

      expect(requests).toHaveLength(2);
      expect(requests[1].document).toContain('canonicalId: $id');
      expect(requests[1].variables).toEqual({ id: CANONICAL, registry: REGISTRY.address });
    });

    it('treats a schema-rejects-the-filter error as a clean miss and stops probing for a while', async () => {
      // The EXACT error live zigens returns for an unknown where-filter field
      // (verified against graphql.ens.dev 2026-07-30): the message does NOT
      // name the field; only extensions.code identifies it as validation.
      nextError = Object.assign(new Error('validation failed'), {
        response: {
          errors: [
            {
              message:
                'Unknown field in input object: the `where` (or similar input) contains a field not declared in its filter type.',
              extensions: { code: 'VALIDATION_ERROR' },
            },
          ],
        },
      });

      const svc = makeV2();
      const first = await svc.getDomainByTokenId(VERSIONED, REGISTRY);
      expect(first.domain).toBeNull(); // no throw — clean miss, callers keep pre-filter behavior

      // Both filters probed (2 primary attempts each: retry-once semantics)…
      const probed = requests.length;
      expect(probed).toBeGreaterThan(0);

      // …and remembered as unsupported: the next lookup issues NO requests.
      const second = await svc.getDomainByTokenId(VERSIONED, REGISTRY);
      expect(second.domain).toBeNull();
      expect(requests).toHaveLength(probed);
    });

    it('also recognizes standard GraphQL unknown-field messages (spec wording, no extensions code)', async () => {
      nextError = Object.assign(new Error('validation failed'), {
        response: {
          errors: [{ message: 'Field "tokenId" is not defined by type "DomainFilter".' }],
        },
      });

      const { domain } = await makeV2().getDomainByTokenId(VERSIONED, REGISTRY);
      expect(domain).toBeNull();
    });

    it('still throws UpstreamError on a genuine outage (transport failure)', async () => {
      nextError = new Error('fetch failed: ECONNREFUSED');

      await expect(makeV2().getDomainByTokenId(VERSIONED, REGISTRY)).rejects.toThrow('ensnode request failed');
    });

    it('scopes both filters to the registry, lowercased (the same id is in every registry with the label)', async () => {
      nextResponse = { domains: [] };
      await makeV2().getDomainByTokenId(VERSIONED, { address: '0x657EA849311d3D5823348ddEd7C2AaAFb3EDE09E', name: 'eth' });

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.document).toContain('where: { registry: $registry,');
        expect(request.variables.registry).toBe(REGISTRY.address);
      }
    });

    describe('a registry several names point at (aliases)', () => {
      const SHARED = { address: '0xb40c4f85b9a7e4b57669c979c16132898a13bedd', name: 'support.vendor.eth' };
      const alias = { id: 'a', name: 'rin.support.shopa.eth', labelName: 'rin' };
      const canonical = { id: 'b', name: 'rin.support.vendor.eth', labelName: 'rin' };

      it("serves the registry's own name when an alias row comes first", async () => {
        queued.push({ domains: [alias] }, { domains: [canonical] });
        const { domain } = await makeV2().getDomainByTokenId(VERSIONED, SHARED);

        expect(domain?.name).toBe('rin.support.vendor.eth');
        expect(requests).toHaveLength(2);
        expect(requests[1].document).toContain('name: $name');
        expect(requests[1].variables).toEqual({ id: VERSIONED, registry: SHARED.address, name: 'rin.support.vendor.eth' });
      });

      it('asks once when the first row already carries that name', async () => {
        nextResponse = { domains: [canonical] };
        await makeV2().getDomainByTokenId(VERSIONED, SHARED);
        expect(requests).toHaveLength(1);
      });

      it('is a miss when no row carries that name', async () => {
        queued.push({ domains: [alias] }, { domains: [] }, { domains: [alias] }, { domains: [] });
        const { domain } = await makeV2().getDomainByTokenId(VERSIONED, SHARED);

        expect(domain).toBeNull();
        expect(requests).toHaveLength(4); // per filter: the first row, then the name
      });
    });

    it("takes the bare label as the root registry's names", async () => {
      nextResponse = { domains: [{ id: 'eth', name: 'eth', labelName: 'eth' }] };
      const root = { address: '0x9703dbd26dab89504490994138cf2c575251a9ce', name: '' };
      const { domain } = await makeV2().getDomainByTokenId(VERSIONED, root);

      expect(domain?.name).toBe('eth');
      expect(requests).toHaveLength(1);
    });

    it('is a miss for a row without a label name (nothing to check its name against)', async () => {
      nextResponse = { domains: [{ id: 'x', name: 'x.eth', labelName: null }] };
      const { domain } = await makeV2().getDomainByTokenId(VERSIONED, REGISTRY);
      expect(domain).toBeNull();
    });

    it('is a no-op on the v1 dialect (the subgraph has no v2 tokens)', async () => {
      const v1 = new IndexerService({ primaryEndpoint: 'https://subgraph.test', apiVersion: 'v1' });
      const { domain } = await v1.getDomainByTokenId(VERSIONED, REGISTRY);

      expect(domain).toBeNull();
      expect(requests).toHaveLength(0);
    });
  });

  describe('getRegistry (a v2 registry by contract address)', () => {
    const ADDRESS = '0x6F076422511cF206088e710DE61ABBE5fAE0E516';
    const LOWER = ADDRESS.toLowerCase();
    const REGISTRY = { address: LOWER, name: 'sepolia.is-a-capybara.eth' };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('queries registry(address) with the lowercased address', async () => {
      nextResponse = { registry: REGISTRY };
      expect(await makeV2().getRegistry(ADDRESS)).toEqual(REGISTRY);

      expect(requests).toHaveLength(1);
      expect(requests[0].document).toContain('registry(address: $address)');
      expect(requests[0].variables).toEqual({ address: LOWER });
    });

    it('reuses a registry for REGISTRY_KNOWN_TTL_MS, then asks again', async () => {
      nextResponse = { registry: REGISTRY };
      const svc = makeV2();
      await svc.getRegistry(ADDRESS);
      vi.advanceTimersByTime(REGISTRY_KNOWN_TTL_MS - 1);
      expect(await svc.getRegistry(LOWER)).toEqual(REGISTRY);
      expect(requests).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await svc.getRegistry(ADDRESS);
      expect(requests).toHaveLength(2);
    });

    it('remembers an address with no registry for REGISTRY_UNKNOWN_TTL_MS, so a random address costs one query', async () => {
      nextResponse = { registry: null };
      const svc = makeV2();
      expect(await svc.getRegistry(ADDRESS)).toBeNull();
      vi.advanceTimersByTime(REGISTRY_UNKNOWN_TTL_MS - 1);
      expect(await svc.getRegistry(ADDRESS)).toBeNull();
      expect(requests).toHaveLength(1);

      // A registry deployed since is recognized once the miss expires.
      vi.advanceTimersByTime(1);
      nextResponse = { registry: REGISTRY };
      expect(await svc.getRegistry(ADDRESS)).toEqual(REGISTRY);
      expect(requests).toHaveLength(2);
    });

    it('throws UpstreamError on an outage and does not cache it', async () => {
      const svc = makeV2();
      nextError = new Error('fetch failed: ECONNREFUSED');
      await expect(svc.getRegistry(ADDRESS)).rejects.toBeInstanceOf(UpstreamError);

      nextError = null;
      nextResponse = { registry: REGISTRY };
      const before = requests.length;
      expect(await svc.getRegistry(ADDRESS)).toEqual(REGISTRY);
      expect(requests.length).toBe(before + 1);
    });

    it('keeps at most REGISTRY_CACHE_MAX_ENTRIES addresses, dropping the least recently used', async () => {
      nextResponse = { registry: null };
      const svc = makeV2();
      const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
      for (let i = 0; i < REGISTRY_CACHE_MAX_ENTRIES; i++) await svc.getRegistry(address(i));
      await svc.getRegistry(address(0)); // a hit: now the most recently used
      expect(requests).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES);

      await svc.getRegistry(address(REGISTRY_CACHE_MAX_ENTRIES)); // one too many
      expect(requests).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES + 1);

      await svc.getRegistry(address(0)); // kept: used after address(1)
      expect(requests).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES + 1);
      await svc.getRegistry(address(1)); // dropped: the least recently used
      expect(requests).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES + 2);
    });

    it('treats a schema without registry(address) as no registry, and stops probing for a while', async () => {
      nextError = Object.assign(new Error('validation failed'), {
        response: { errors: [{ message: 'Cannot query field "registry" on type "Query".' }] },
      });
      const svc = makeV2();
      expect(await svc.getRegistry(ADDRESS)).toBeNull();
      const probed = requests.length;
      expect(await svc.getRegistry('0x' + '22'.repeat(20))).toBeNull();
      expect(requests).toHaveLength(probed);
    });

    it('is null on the v1 dialect, without a query', async () => {
      const v1 = new IndexerService({ primaryEndpoint: 'https://subgraph.test', apiVersion: 'v1' });
      expect(await v1.getRegistry(ADDRESS)).toBeNull();
      expect(requests).toHaveLength(0);
    });
  });

  it('the v1 dialect still queries by namehash (regression guard for mainnet)', async () => {
    const v1 = new IndexerService({ primaryEndpoint: 'https://subgraph.test', apiVersion: 'v1' });
    nextResponse = { domain: null };
    await v1.getDomain('fox.eth');

    expect(requests[0].variables).toEqual({ name: namehash('fox.eth') });
  });
});

// A 200 whose body is not an answer to the query (a proxy or maintenance page,
// {"data":null}, {"data":{}}) must fail like a transport error, not read as "no
// such name": the fallback layer would take that for a clean miss (→ 404).
describe('IndexerService — a response that is not an answer', () => {
  const lookups: Array<[string, (idx: IndexerService) => Promise<unknown>, string]> = [
    ['getDomain', (idx) => idx.getDomain('fox.eth'), 'domain'],
    ['getDomainByNamehash', (idx) => idx.getDomainByNamehash(namehash('fox.eth')), 'domain'],
    ['getDomains', (idx) => idx.getDomains(['fox.eth']), 'domains'],
    ['getMigrationStatus', (idx) => idx.getMigrationStatus('fox.eth'), 'domain'],
    ['getHierarchy', (idx) => idx.getHierarchy('fox.eth'), 'domain'],
  ];
  const NOT_ANSWERS: Array<[string, unknown]> = [
    ['no data', undefined],
    ['data: null', null],
    ['data: {}', {}],
    ['another field', { domainz: null, domainss: [] }],
  ];

  beforeEach(() => {
    requests.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each(lookups.flatMap(([method, call]) => NOT_ANSWERS.map(([label, body]) => [method, label, call, body] as const)))(
    '%s with %s: UpstreamError after the retry',
    async (_method, _label, call, body) => {
      nextResponse = body;
      await expect(call(makeV2())).rejects.toBeInstanceOf(UpstreamError);
      expect(requests).toHaveLength(2);
    },
  );

  it.each(lookups)('%s with the queried field present and null (or empty) is an answer', async (_method, call, field) => {
    nextResponse = { [field]: field === 'domains' ? [] : null };
    await expect(call(makeV2())).resolves.toBeDefined();
    expect(requests).toHaveLength(1);
  });
});
