import { describe, it, expect } from 'vitest';
import { classifyMigrationStatus, isOnV2, isReservedOwner } from '../src/utils/migration';
import { MIGRATION_STATUS } from '../src/types';

const ZERO = '0x0000000000000000000000000000000000000000';

describe('classifyMigrationStatus (3-state model: unmigrated | migrated | native)', () => {
  it('classifies a v1 name as unmigrated', () => {
    expect(classifyMigrationStatus({ isUnmigrated: true })).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('classifies a v2 name moved from v1 as migrated', () => {
    expect(classifyMigrationStatus({ isOnV2: true, bornOnV2: false })).toBe(MIGRATION_STATUS.MIGRATED);
  });

  it('classifies a v2 name born on v2 as native', () => {
    expect(classifyMigrationStatus({ isOnV2: true, bornOnV2: true })).toBe(MIGRATION_STATUS.NATIVE);
  });

  it('treats on-v2 without known provenance as migrated', () => {
    expect(classifyMigrationStatus({ isOnV2: true })).toBe(MIGRATION_STATUS.MIGRATED);
  });

  it('unmigrated takes precedence over any v2 signal', () => {
    expect(classifyMigrationStatus({ isUnmigrated: true, isOnV2: true, bornOnV2: true }))
      .toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('defaults to unmigrated when nothing is known (never falsely advertises v2)', () => {
    expect(classifyMigrationStatus({})).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('classifies a RESERVED placeholder (owner=0) as unmigrated, not native', () => {
    // Pre-seeded v1 name: present in v2, migrated flag clear, no owner.
    expect(classifyMigrationStatus({ isOnV2: true, isReserved: true, bornOnV2: true }))
      .toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('reserved takes precedence over a migrated signal too', () => {
    expect(classifyMigrationStatus({ isOnV2: true, isReserved: true, bornOnV2: false }))
      .toBe(MIGRATION_STATUS.UNMIGRATED);
  });
});

describe('isReservedOwner', () => {
  it('is true for a zero / absent owner (RESERVED placeholder)', () => {
    expect(isReservedOwner(ZERO)).toBe(true);
    expect(isReservedOwner(ZERO.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isReservedOwner(undefined)).toBe(true);
    expect(isReservedOwner(null)).toBe(true);
    expect(isReservedOwner('')).toBe(true);
  });
  it('is false for a real owner address', () => {
    expect(isReservedOwner('0x1234567890123456789012345678901234567890')).toBe(false);
  });
});

describe('isOnV2', () => {
  it('is true for migrated and native', () => {
    expect(isOnV2(MIGRATION_STATUS.MIGRATED)).toBe(true);
    expect(isOnV2(MIGRATION_STATUS.NATIVE)).toBe(true);
  });
  it('is false for unmigrated', () => {
    expect(isOnV2(MIGRATION_STATUS.UNMIGRATED)).toBe(false);
  });
});
