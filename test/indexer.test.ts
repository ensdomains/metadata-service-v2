import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IndexerService,
  MAX_REGISTRY_LABELS_SCANNED,
  REGISTRY_CACHE_MAX_ENTRIES,
  REGISTRY_KNOWN_TTL_MS,
  REGISTRY_UNKNOWN_TTL_MS,
} from '../src/services/indexer';
import { UpstreamError } from '../src/services/errors';
import { labelhash, namehash } from '../src/utils/ens';
import { classifyV2IndexerRecord } from '../src/utils/migration';
import { MIGRATION_STATUS } from '../src/types';

const ENDPOINT = 'https://sepolia.api.bigname.test';
const CHAIN_ID = 11155111;
const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const RESOLVER = '0x3df10566a3f1b90dd692b49ec6f3653f5bce6cff';

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

let calls: Call[];
let responses: Array<() => Response>;

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown, page?: unknown) => json(200, page ? { data, page } : { data });
const error = (status: number, code: string) => json(status, { error: { code, message: code, details: {} } });

const v2Name = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  namehash: namehash(name),
  status: 'active',
  authority: 'ens_v2',
  owner: OWNER,
  expires_at: '1893456000',
  created_at: '1713615816',
  registered_at: '1790980428',
  resolver: { chain_id: CHAIN_ID, address: RESOLVER },
  ...extra,
});

const make = () => new IndexerService({ endpoint: `${ENDPOINT}/`, chainId: CHAIN_ID });

beforeEach(() => {
  calls = [];
  responses = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('fetch failed: no response queued');
    return next();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getDomain', () => {
  it('reads the name detail route with the lowercased name', async () => {
    responses.push(ok(v2Name('fox.eth')));
    await make().getDomain('Fox.ETH');
    expect(calls).toEqual([{ url: `${ENDPOINT}/v1/names/fox.eth`, method: 'GET', body: undefined }]);
  });

  it('maps an ENSv2 row to the domain shape', async () => {
    responses.push(ok(v2Name('fox.eth', { token_id: '123' })));
    const { domain } = await make().getDomain('fox.eth');
    expect(domain).toEqual({
      id: namehash('fox.eth'),
      name: 'fox.eth',
      labelName: 'fox',
      labelhash: labelhash('fox'),
      parentId: namehash('eth'),
      parent: { id: namehash('eth'), name: 'eth' },
      ownerId: OWNER,
      owner: { id: OWNER },
      registrantId: undefined,
      registrant: undefined,
      resolverId: RESOLVER,
      resolver: { address: RESOLVER },
      expiryDate: '1893456000',
      createdAt: '1713615816',
      isMigrated: undefined,
      tokenId: '123',
      protocol: 'v2',
    });
  });

  it('reads `migrated_at` as a migration, and its absence as unknown', async () => {
    responses.push(ok(v2Name('fox.eth', { migrated_at: '1790980428' })), ok(v2Name('new.eth')));
    const svc = make();
    expect((await svc.getDomain('fox.eth')).domain?.isMigrated).toBe(true);
    expect((await svc.getDomain('new.eth')).domain?.isMigrated).toBeUndefined();
  });

  it.each([['ens_v1'], ['ens_v0']])('maps %s to protocol v1, with the holder as registrant of a .eth name', async (authority) => {
    responses.push(ok(v2Name('old.eth', { authority })));
    const { domain } = await make().getDomain('old.eth');
    expect(domain?.protocol).toBe('v1');
    expect(domain?.registrantId).toBe(OWNER);
  });

  it('prefers the ENSv1 registry pointer, keeping an explicit null', async () => {
    const pointer = { chain_id: CHAIN_ID, address: '0xa7c24d3686a3d6235727f2a9645f8b2471e51b0c' };
    responses.push(
      ok(v2Name('a.eth', { authority: 'ens_v1', ens_v1: { resolver: pointer } })),
      ok(v2Name('b.eth', { authority: 'ens_v1', ens_v1: { resolver: null } })),
      ok(v2Name('c.eth', { authority: 'ens_v1', ens_v1: { wrapper_state: 'unwrapped' } })),
    );
    const svc = make();
    expect((await svc.getDomain('a.eth')).domain?.resolverId).toBe(pointer.address);
    expect((await svc.getDomain('b.eth')).domain?.resolver).toBeUndefined();
    expect((await svc.getDomain('c.eth')).domain?.resolverId).toBe(RESOLVER);
  });

  it.each([['9223372036854775807'], ['18446744073709551615']])('drops an expiry of %s (never expires)', async (expiry) => {
    responses.push(ok(v2Name('wrapped.eth', { expires_at: expiry })));
    expect((await make().getDomain('wrapped.eth')).domain?.expiryDate).toBeUndefined();
  });

  it('serves a released name with its release time as the expiry', async () => {
    responses.push(ok(v2Name('gone.eth', {
      status: 'released',
      owner: null,
      expires_at: '1700000000',
      lapsed_registration: { released_at: '1702419200' },
    })));
    const { domain } = await make().getDomain('gone.eth');
    expect(domain?.expiryDate).toBe('1702419200');
    expect(domain?.owner).toBeUndefined();
  });

  it('is an UpstreamError for a name detail without its name', async () => {
    responses.push(ok({ names: null }));
    await expect(make().getDomain('fox.eth')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('is null for a 404 not_found and for an unregistered name', async () => {
    responses.push(error(404, 'not_found'), ok(v2Name('never.eth', { status: 'unregistered' })));
    const svc = make();
    expect((await svc.getDomain('missing.eth')).domain).toBeNull();
    expect((await svc.getDomain('never.eth')).domain).toBeNull();
  });
});

describe('a failed request', () => {
  it('retries a stale answer, then serves the next one', async () => {
    responses.push(error(409, 'stale'), ok(v2Name('fox.eth')));
    expect((await make().getDomain('fox.eth')).domain?.name).toBe('fox.eth');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['stale', error(409, 'stale')],
    ['a server error', error(500, 'internal_error')],
    ['overloaded', error(503, 'overloaded')],
    ['a transport failure', () => { throw new Error('fetch failed: ECONNREFUSED'); }],
    ['no data field', json(200, {})],
    ['data: null', ok(null)],
    ['a non-JSON body', () => new Response('<html>maintenance</html>', { status: 200 })],
  ])('is an UpstreamError after three attempts of %s', async (_label, response) => {
    responses.push(response, response, response);
    await expect(make().getDomain('fox.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['conflict', error(409, 'conflict')],
    ['invalid input', error(400, 'invalid_input')],
    ['unsupported', error(422, 'unsupported')],
  ])('is an UpstreamError without a retry for %s', async (_label, response) => {
    responses.push(response);
    await expect(make().getDomain('fox.eth')).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1);
  });
});

describe('getEthDomainByLabelhash', () => {
  const hash = labelhash('fox');

  it('reads the .eth name with its label spelled as the bracketed labelhash', async () => {
    responses.push(ok(v2Name('fox.eth')));
    const { domain } = await make().getEthDomainByLabelhash(hash);
    expect(calls[0].url).toBe(`${ENDPOINT}/v1/names/${encodeURIComponent(`[${hash.slice(2)}].eth`)}`);
    expect(domain?.name).toBe('fox.eth');
  });

  it('is a miss when bigname does not know the label', async () => {
    responses.push(ok(v2Name(`[${hash.slice(2)}].eth`)));
    expect((await make().getEthDomainByLabelhash(hash)).domain).toBeNull();
  });
});

describe('getDomains', () => {
  it('reads every name in one lookup and leaves out the ones it cannot answer', async () => {
    responses.push(ok([
      { status: 'ok', input: { name: 'fox.eth' }, kind: 'name', record: v2Name('fox.eth') },
      { status: 'not_found', input: { name: 'missing.eth' }, kind: 'name' },
      { status: 'stale', input: { name: 'busy.eth' }, kind: 'name' },
      { status: 'ok', input: { name: 'never.eth' }, kind: 'name', record: v2Name('never.eth', { status: 'unregistered' }) },
    ]));
    const { domains } = await make().getDomains(['Fox.eth', 'missing.eth', 'busy.eth', 'never.eth']);

    expect(calls).toEqual([{
      url: `${ENDPOINT}/v1/lookup`,
      method: 'POST',
      body: {
        namespace: 'ens',
        profile: 'detail',
        inputs: [{ name: 'fox.eth' }, { name: 'missing.eth' }, { name: 'busy.eth' }, { name: 'never.eth' }],
      },
    }]);
    expect(domains.map((d) => d.name)).toEqual(['fox.eth']);
  });

  it('is an UpstreamError when the answer does not match the inputs', async () => {
    responses.push(ok([]));
    await expect(make().getDomains(['fox.eth'])).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('getMigrationStatus', () => {
  it('carries the protocol and the migration flag', async () => {
    responses.push(ok(v2Name('fox.eth', { migrated_at: '1790980428' })));
    const { status } = await make().getMigrationStatus('fox.eth');
    expect(status).toMatchObject({ name: 'fox.eth', isMigrated: true, protocol: 'v2', owner: { id: OWNER } });
  });

  it('is null for an unknown name', async () => {
    responses.push(error(404, 'not_found'));
    expect((await make().getMigrationStatus('missing.eth')).status).toBeNull();
  });

  it('keeps an unknown migration history unknown (never read as born on v2)', async () => {
    responses.push(ok(v2Name('fox.eth')));
    const { status } = await make().getMigrationStatus('fox.eth');
    expect(status?.isMigrated).toBeUndefined();
    expect(classifyV2IndexerRecord(status!)).toBe(MIGRATION_STATUS.MIGRATED);
  });
});

describe('getHierarchy', () => {
  const result = (name: string, status = 'ok') => ({
    status,
    kind: 'name',
    input: { name },
    record: status === 'ok' ? v2Name(name) : undefined,
  });

  it('reads the name and two ancestors in one lookup', async () => {
    responses.push(ok([result('a.b.fox.eth'), result('b.fox.eth'), result('fox.eth')]));
    const { hierarchy } = await make().getHierarchy('a.b.fox.eth');

    expect((calls[0].body as { inputs: unknown[] }).inputs).toEqual([
      { name: 'a.b.fox.eth' }, { name: 'b.fox.eth' }, { name: 'fox.eth' },
    ]);
    expect(hierarchy?.name).toBe('a.b.fox.eth');
    expect(hierarchy?.parent?.name).toBe('b.fox.eth');
    expect(hierarchy?.parent?.parent?.name).toBe('fox.eth');
    expect(hierarchy?.parent?.parent?.parent).toBeUndefined();
  });

  it('leaves out an ancestor it cannot answer', async () => {
    responses.push(ok([result('fox.eth'), result('eth', 'stale')]));
    const { hierarchy } = await make().getHierarchy('fox.eth');
    expect(hierarchy?.name).toBe('fox.eth');
    expect(hierarchy?.parent).toBeUndefined();
  });

  it('is null when the name itself is not found', async () => {
    responses.push(ok([result('missing.eth', 'not_found'), result('eth')]));
    expect((await make().getHierarchy('missing.eth')).hierarchy).toBeNull();
  });

  it('is an UpstreamError when the name itself cannot be answered', async () => {
    responses.push(ok([result('fox.eth', 'stale'), result('eth')]));
    await expect(make().getHierarchy('fox.eth')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('getDomainByTokenId', () => {
  const REGISTRY = '0x6F076422511cF206088e710DE61ABBE5fAE0E516';
  const LOWER = REGISTRY.toLowerCase();
  const fooHash = labelhash('foo');
  // A native token id: the labelhash with its low 32 bits replaced by the version.
  const fooToken = `${fooHash.slice(0, -8)}00000003` as `0x${string}`;
  const overview = (name: string | null, labels = 2) =>
    ok({ chain_id: CHAIN_ID, address: LOWER, name: name === null ? null : { name }, counts: { labels } });
  const label = (name: string, extra: Record<string, unknown> = {}) =>
    v2Name(name, { labelhash: labelhash(name.split('.')[0]), ...extra });

  it("names the token under the registry's own name", async () => {
    responses.push(overview('vendor.eth'), ok([label('bar.alias.eth'), label('foo.alias.eth')]));
    const { domain } = await make().getDomainByTokenId(fooToken, REGISTRY);

    expect(calls.map((c) => c.url)).toEqual([
      `${ENDPOINT}/v1/registries/${CHAIN_ID}/${LOWER}`,
      `${ENDPOINT}/v1/registries/${CHAIN_ID}/${LOWER}/labels?page_size=200`,
    ]);
    expect(domain?.name).toBe('foo.vendor.eth');
    expect(domain?.id).toBe(namehash('foo.vendor.eth'));
  });

  it('takes the bare label in the root registry', async () => {
    responses.push(overview(''), ok([label('foo')]));
    expect((await make().getDomainByTokenId(fooToken, REGISTRY)).domain?.name).toBe('foo');
  });

  it('follows the cursor to later pages', async () => {
    responses.push(
      overview('vendor.eth', 300),
      ok([label('bar.vendor.eth')], { next_cursor: 'abc' }),
      ok([label('foo.vendor.eth')], { next_cursor: null }),
    );
    expect((await make().getDomainByTokenId(fooToken, REGISTRY)).domain?.name).toBe('foo.vendor.eth');
    expect(calls[2].url).toContain('cursor=abc');
  });

  it('is a miss for an unknown registry, one with no name, or too many labels', async () => {
    responses.push(error(404, 'not_found'), overview(null), overview('eth', MAX_REGISTRY_LABELS_SCANNED + 1));
    const svc = make();
    expect((await svc.getDomainByTokenId(fooToken, REGISTRY)).domain).toBeNull();
    expect((await svc.getDomainByTokenId(fooToken, REGISTRY)).domain).toBeNull();
    expect((await svc.getDomainByTokenId(fooToken, REGISTRY)).domain).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['an overview without its address', [ok({})]],
    ['labels that are not a list', [overview('vendor.eth'), ok({ labels: [] })]],
  ])('is an UpstreamError for %s', async (_label, replies) => {
    responses.push(...replies);
    await expect(make().getDomainByTokenId(fooToken, REGISTRY)).rejects.toBeInstanceOf(UpstreamError);
  });

  it.each([['released'], ['unregistered']])('is a miss for a %s label', async (status) => {
    responses.push(overview('vendor.eth'), ok([label('foo.vendor.eth', { status })]));
    expect((await make().getDomainByTokenId(fooToken, REGISTRY)).domain).toBeNull();
  });

  it('is a miss when no label matches', async () => {
    responses.push(overview('vendor.eth'), ok([label('bar.vendor.eth')], { next_cursor: null }));
    expect((await make().getDomainByTokenId(fooToken, REGISTRY)).domain).toBeNull();
  });
});

describe('isRegistry', () => {
  const ADDRESS = '0x6F076422511cF206088e710DE61ABBE5fAE0E516';
  const LOWER = ADDRESS.toLowerCase();
  const registry = () => ok({ chain_id: CHAIN_ID, address: LOWER, name: { name: 'vendor.eth' } });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the registry route with the lowercased address', async () => {
    responses.push(registry());
    expect(await make().isRegistry(ADDRESS)).toBe(true);
    expect(calls[0].url).toBe(`${ENDPOINT}/v1/registries/${CHAIN_ID}/${LOWER}`);
  });

  it('reuses a hit for REGISTRY_KNOWN_TTL_MS, then asks again', async () => {
    responses.push(registry(), registry());
    const svc = make();
    await svc.isRegistry(ADDRESS);
    vi.advanceTimersByTime(REGISTRY_KNOWN_TTL_MS - 1);
    expect(await svc.isRegistry(LOWER)).toBe(true);
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await svc.isRegistry(ADDRESS);
    expect(calls).toHaveLength(2);
  });

  it('remembers an address with no registry for REGISTRY_UNKNOWN_TTL_MS', async () => {
    responses.push(error(404, 'not_found'), registry());
    const svc = make();
    expect(await svc.isRegistry(ADDRESS)).toBe(false);
    vi.advanceTimersByTime(REGISTRY_UNKNOWN_TTL_MS - 1);
    expect(await svc.isRegistry(ADDRESS)).toBe(false);
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(await svc.isRegistry(ADDRESS)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('throws UpstreamError on an outage and does not cache it', async () => {
    const down = () => { throw new Error('fetch failed: ECONNREFUSED'); };
    responses.push(down, down, down, registry());
    const svc = make();
    await expect(svc.isRegistry(ADDRESS)).rejects.toBeInstanceOf(UpstreamError);
    expect(await svc.isRegistry(ADDRESS)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('throws UpstreamError for an overview without its address, and does not cache it', async () => {
    responses.push(ok({}), registry());
    const svc = make();
    await expect(svc.isRegistry(ADDRESS)).rejects.toBeInstanceOf(UpstreamError);
    expect(await svc.isRegistry(ADDRESS)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('keeps at most REGISTRY_CACHE_MAX_ENTRIES addresses, dropping the least recently used', async () => {
    const svc = make();
    const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
    for (let i = 0; i <= REGISTRY_CACHE_MAX_ENTRIES + 2; i++) responses.push(error(404, 'not_found'));
    for (let i = 0; i < REGISTRY_CACHE_MAX_ENTRIES; i++) await svc.isRegistry(address(i));
    await svc.isRegistry(address(0)); // a hit: now the most recently used
    expect(calls).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES);

    await svc.isRegistry(address(REGISTRY_CACHE_MAX_ENTRIES)); // one too many
    expect(calls).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES + 1);

    await svc.isRegistry(address(0)); // kept: used after address(1)
    expect(calls).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES + 1);
    await svc.isRegistry(address(1)); // dropped: the least recently used
    expect(calls).toHaveLength(REGISTRY_CACHE_MAX_ENTRIES + 2);
  });
});

describe('healthCheck', () => {
  it('reads /v1/status and reports its latency', async () => {
    responses.push(ok({ status: 'ready' }));
    const health = await make().healthCheck();
    expect(calls[0].url).toBe(`${ENDPOINT}/v1/status`);
    expect(health.primary).toBe(true);
    expect(health.latency.primary).toBeTypeOf('number');
  });

  it('is unhealthy when the status route fails', async () => {
    responses.push(error(503, 'overloaded'));
    expect((await make().healthCheck()).primary).toBe(false);
  });
});
