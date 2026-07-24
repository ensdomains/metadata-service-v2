import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every GraphQL request the IndexerService issues so the v2 (zigens)
// dialect's wire shape is pinned by tests: id = lowercased NAME STRING (the v1
// subgraph uses namehashes), batch filter = name_in, and the domain shape must
// request the v2 signals (protocol, tokenId, isMigrated). Schema verified live
// against graphql.ens.dev.
const requests: Array<{ document: string; variables: Record<string, unknown> }> = [];
let nextResponse: unknown = { domain: null };

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    request: vi.fn(async (opts: { document: string; variables: Record<string, unknown> }) => {
      requests.push({ document: opts.document, variables: opts.variables });
      return nextResponse;
    }),
  })),
}));

import { IndexerService } from '../src/services/indexer';
import { namehash } from '../src/utils/ens';

function makeV2() {
  return new IndexerService({ primaryEndpoint: 'https://zigens.test/graphql', apiVersion: 'v2' });
}

describe('IndexerService — v2 (zigens) dialect', () => {
  beforeEach(() => {
    requests.length = 0;
    nextResponse = { domain: null };
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

  it('the v1 dialect still queries by namehash (regression guard for mainnet)', async () => {
    const v1 = new IndexerService({ primaryEndpoint: 'https://subgraph.test', apiVersion: 'v1' });
    nextResponse = { domain: null };
    await v1.getDomain('fox.eth');

    expect(requests[0].variables).toEqual({ name: namehash('fox.eth') });
  });
});
