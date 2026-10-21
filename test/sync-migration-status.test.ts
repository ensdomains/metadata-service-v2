import { describe, it, expect, vi } from 'vitest';
import { SyncService, DEFAULT_SYNC_CONFIG } from '../src/services/sync';
import { MIGRATION_STATUS } from '../src/types';

// D1 is the LAST-RESORT tier — what sync writes there is what gets served when
// every live source is down. It must store the real classified status, not a
// hardcoded 'unmigrated' (the old behavior, which made D1 permanently mislabel
// every migrated/native name).

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

function makeD1() {
  return {
    getMigrationStatus: vi.fn().mockResolvedValue(null),
    storeMigrationStatus: vi.fn().mockResolvedValue(undefined),
    updateSyncStatus: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeIndexer(status: Record<string, unknown> | null) {
  return {
    getMigrationStatus: vi.fn().mockResolvedValue({ status }),
  } as any;
}

describe('SyncService.syncMigrationStatus — real status in D1', () => {
  it('stores native for an ENSv2 record born on v2', async () => {
    const d1 = makeD1();
    const sync = new SyncService(d1, makeIndexer({
      name: 'fox.eth', isMigrated: false, owner: { id: OWNER }, protocol: 'v2', expiryDate: '1853706120',
    }), DEFAULT_SYNC_CONFIG);

    await sync.syncMigrationStatus('fox.eth');

    expect(d1.storeMigrationStatus).toHaveBeenCalledWith('fox.eth', MIGRATION_STATUS.NATIVE, {
      owner: OWNER,
      expirationDate: '1853706120',
    });
  });

  it('stores migrated for an ENSv2 record migrated from v1', async () => {
    const d1 = makeD1();
    const sync = new SyncService(d1, makeIndexer({
      name: 'moved.eth', isMigrated: true, owner: { id: OWNER }, protocol: 'v2',
    }), DEFAULT_SYNC_CONFIG);

    await sync.syncMigrationStatus('moved.eth');

    expect(d1.storeMigrationStatus.mock.calls[0][1]).toBe(MIGRATION_STATUS.MIGRATED);
  });

  it('stores unmigrated for a RESERVED pre-seed (owner 0x0)', async () => {
    const d1 = makeD1();
    const sync = new SyncService(d1, makeIndexer({
      name: 'vitalik.eth', isMigrated: false, owner: { id: ZERO }, protocol: 'v2',
    }), DEFAULT_SYNC_CONFIG);

    await sync.syncMigrationStatus('vitalik.eth');

    expect(d1.storeMigrationStatus.mock.calls[0][1]).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('stores unmigrated for an ENSv1 record', async () => {
    const d1 = makeD1();
    const sync = new SyncService(d1, makeIndexer({
      name: 'old.eth', isMigrated: false, owner: { id: OWNER }, protocol: 'v1',
    }), DEFAULT_SYNC_CONFIG);

    await sync.syncMigrationStatus('old.eth');

    expect(d1.storeMigrationStatus.mock.calls[0][1]).toBe(MIGRATION_STATUS.UNMIGRATED);
  });
});
