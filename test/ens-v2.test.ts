import { describe, it, expect } from 'vitest';
import { eth2ldLabel } from '../src/utils/ens';
import { classifyV2IndexerRecord } from '../src/utils/migration';
import { MIGRATION_STATUS } from '../src/types';

// The ETHRegistry keys .eth 2LD labels ONLY — this helper is what keeps
// subnames from being classified by the status of an unrelated 2LD
// (sub.foo.eth must key on 'foo', never 'sub').
describe('eth2ldLabel', () => {
  it('returns the label for a .eth 2LD', () => {
    expect(eth2ldLabel('fox.eth')).toBe('fox');
  });

  it('returns the 2LD label (not the first label) for subnames', () => {
    expect(eth2ldLabel('sub.foo.eth')).toBe('foo');
    expect(eth2ldLabel('a.b.c.foo.eth')).toBe('foo');
  });

  it('returns null for non-.eth names', () => {
    expect(eth2ldLabel('example.com')).toBeNull();
    expect(eth2ldLabel('foo.xyz')).toBeNull();
  });

  it('returns null for the bare eth TLD', () => {
    expect(eth2ldLabel('eth')).toBeNull();
  });
});

// Shared v2-indexer (zigens) record classifier — one source of truth for
// MetadataService AND SyncService (D1 rows).
describe('classifyV2IndexerRecord', () => {
  it('classifies a name born on v2 as native (isMigrated=false, real owner)', () => {
    // Mirrors the live zigens record for fox.eth (verified against graphql.ens.dev)
    expect(classifyV2IndexerRecord({
      isMigrated: false,
      owner: { id: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809' },
      protocol: 'v2',
    })).toBe(MIGRATION_STATUS.NATIVE);
  });

  it('classifies a v1→v2 migrated name as migrated (isMigrated=true)', () => {
    expect(classifyV2IndexerRecord({
      isMigrated: true,
      owner: { id: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809' },
      protocol: 'v2',
    })).toBe(MIGRATION_STATUS.MIGRATED);
  });

  it('classifies a RESERVED pre-seed (owner == 0x0) as unmigrated, never native', () => {
    expect(classifyV2IndexerRecord({
      isMigrated: false, // flag is clear on reserved rows — the trap this guards
      owner: { id: '0x0000000000000000000000000000000000000000' },
      protocol: 'v2',
    })).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('classifies an absent/undefined owner as unmigrated (reserved-equivalent)', () => {
    expect(classifyV2IndexerRecord({ isMigrated: false })).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('classifies a protocol:"v1" row as unmigrated — presence in the index is NOT proof of v2', () => {
    // zigens' schema serves both protocols; a legacy row must never classify native.
    expect(classifyV2IndexerRecord({
      isMigrated: false,
      owner: { id: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809' },
      protocol: 'v1',
    })).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('honors ownerId when the nested owner object is absent', () => {
    expect(classifyV2IndexerRecord({
      isMigrated: true,
      ownerId: '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809',
    })).toBe(MIGRATION_STATUS.MIGRATED);
  });
});
