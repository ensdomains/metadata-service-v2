import { describe, it, expect } from 'vitest';
import { D1Service } from '../src/services/d1';
import { namehash } from '../src/utils/ens';

// D1 is the last-resort tier and is keyed by name. Rows are written lowercase
// (indexer records) or canonicalized (webhook), but reads used to bind the RAW
// request name, so a mixed-case URL like `Fox.eth` never hit its own `fox.eth`
// row and the last resort silently never fired. Every name-keyed read AND write
// must canonicalize at the storage boundary so both sides agree.

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

function makeDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return {
          first: async () => null,
          all: async () => ({ results: [], success: true, meta: {} }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
      },
    }),
  } as unknown as D1Database;
  return { db, calls };
}

describe('D1Service canonicalizes names on reads', () => {
  it('getDomain binds the canonical name', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').getDomain('Fox.ETH');
    expect(calls[0].args).toEqual(['mainnet', 'fox.eth']);
  });

  it('getMigrationStatus binds the canonical name', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'sepolia').getMigrationStatus('Fox.ETH');
    expect(calls[0].args).toEqual(['sepolia', 'fox.eth']);
  });

  it('getHierarchy keys the root by the canonical namehash', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').getHierarchy('Sub.Fox.ETH');
    expect(calls[0].args).toEqual(['mainnet', namehash('sub.fox.eth')]);
  });

  it('getDomains canonicalizes every name in the IN list', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').getDomains(['Fox.ETH', 'BAR.eth', 'baz.eth']);
    expect(calls[0].args).toEqual(['mainnet', 'fox.eth', 'bar.eth', 'baz.eth']);
  });
});

describe('D1Service canonicalizes names on writes', () => {
  it('storeDomain stores the canonical name, id and label', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').storeDomain({ name: 'Fox.ETH', ownerId: OWNER } as any, 'ensnode');
    const [network, id, name, labelName] = calls[0].args;
    expect(network).toBe('mainnet');
    expect(id).toBe(namehash('fox.eth'));
    expect(name).toBe('fox.eth');
    expect(labelName).toBe('fox');
  });

  it('storeMigrationStatus stores the canonical name and id', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'sepolia').storeMigrationStatus('Fox.ETH', 'migrated', { owner: OWNER });
    const [network, id, name, status] = calls[0].args;
    expect(network).toBe('sepolia');
    expect(id).toBe(namehash('fox.eth'));
    expect(name).toBe('fox.eth');
    expect(status).toBe('migrated');
  });

  it('storeHierarchy keys the root and every level by canonical names', async () => {
    const { db, calls } = makeDb();
    await new D1Service(db, 'mainnet').storeHierarchy('Fox.ETH', [
      { name: 'ETH', owner: ZERO, resolver: ZERO, level: 1 },
      { name: 'Fox.ETH', owner: OWNER, resolver: ZERO, level: 2 },
    ]);
    // DELETE by root id, then one INSERT per level.
    expect(calls[0].sql).toContain('DELETE');
    expect(calls[0].args).toEqual(['mainnet', namehash('fox.eth')]);
    expect(calls[1].args.slice(0, 3)).toEqual(['mainnet', namehash('eth'), 'eth']);
    expect(calls[2].args.slice(0, 3)).toEqual(['mainnet', namehash('fox.eth'), 'fox.eth']);
    expect(calls[2].args[6]).toBe(namehash('eth')); // parent_id resolved from the canonical level-1 name
  });

  it('a read after a write with different casing hits the same key', async () => {
    const { db, calls } = makeDb();
    const svc = new D1Service(db, 'mainnet');
    await svc.storeMigrationStatus('fox.eth', 'native', {});
    await svc.getMigrationStatus('FOX.eth');
    expect(calls[0].args[2]).toBe(calls[1].args[1]);
  });
});
