// ENS v1 → v2 migration lifecycle model.
//
// Single source of truth for "what state is a name in, with respect to the
// v1→v2 migration?". It drives cache TTL and the on-image badge.
//
// THREE STATES (mutually exclusive):
//
//   unmigrated  Name still lives on ENS v1 (the legacy registry). Not present in
//               the v2 registry. Volatile-ish → short cache TTL.
//
//   migrated    Name moved from v1 → v2. Present in v2 with the indexer's
//               `migrated` flag set. Stable → long cache TTL.
//
//   native      Name was *born on v2* — registered directly via the v2 registry,
//               never existed on v1. Present in v2 with the indexer's `migrated`
//               flag clear. Stable → long cache TTL.
//
// `migrated` vs `native` is the distinction the indexer deliberately exposes:
// zigens (the ENS v2 indexer) stores `migrated: bool` per name and emits a
// dedicated `NameMigrated` event "distinct from `name_registered` so consumers
// can filter on 'migration' specifically (vs first-time mint)"
// (zigens src/types/models.zig).
//
// RESERVED → `unmigrated`:
//   The v2 registry has three on-chain states (IPermissionedRegistry.Status):
//   AVAILABLE(0) | RESERVED(1) | REGISTERED(2). Pre-migration bulk-seeds EVERY v1
//   .eth 2LD into v2 as RESERVED — owner = address(0), the ENSV1Resolver set as
//   resolver so it still resolves via v1, v1 expiry preserved (see the v2
//   contracts' docs/premigration.md). A RESERVED name is therefore still
//   v1-authoritative: its owner has not claimed it on v2. We classify it as
//   `unmigrated`. CRUCIAL: a RESERVED entry is present in the v2 index with the
//   migrated flag clear, so without an owner==0 guard it would be misread as
//   `native`. `native` vs `migrated` is decided by the registration *sender*
//   (ETHRegistrar vs a migration controller), not the owner — both end up owned
//   by the real user.
//

import { MIGRATION_STATUS, type MigrationStatus } from '../types';

export interface MigrationSignals {
  /**
   * True when the name is NOT present in the v2 registry, i.e. it still resolves
   * via the legacy v1 registry. On sepolia this is "no domain returned by the v2
   * indexer"; on mainnet it comes from the on-chain unmigrated check.
   */
  isUnmigrated?: boolean;
  /** The name is present in the v2 registry (mainnet). */
  isOnV2?: boolean;
  /**
   * The v2 entry is a pre-seeded RESERVED placeholder (owner == address(0)) — it
   * still resolves via v1 and has not been claimed on v2. Classified as
   * `unmigrated`. Takes precedence over `bornOnV2`/`isOnV2` so a reserved entry
   * is never mistaken for a `native` registration.
   */
  isReserved?: boolean;
  /**
   * Provenance: the v2 name was registered directly on v2 (first-time mint via
   * ETHRegistrar), never migrated from v1. Derived from the indexer's `migrated`
   * flag being clear (zigens `migrated == false`, set from the registration
   * sender). Only meaningful together with `isOnV2` and a non-reserved entry.
   */
  bornOnV2?: boolean;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * A v2 entry with a zero/absent owner is a pre-seeded RESERVED placeholder
 * (still v1-authoritative), not a real registration. See the RESERVED note above.
 */
export function isReservedOwner(ownerId?: string | null): boolean {
  return !ownerId || ownerId.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Reduce the available on-chain / indexer signals to a single canonical
 * `MigrationStatus`. Precedence: unmigrated/reserved > native > migrated, with a
 * safe `unmigrated` default when nothing is known (so we never falsely advertise
 * a name as living on v2).
 */
export function classifyMigrationStatus(signals: MigrationSignals): MigrationStatus {
  if (signals.isUnmigrated) return MIGRATION_STATUS.UNMIGRATED;
  if (signals.isReserved) return MIGRATION_STATUS.UNMIGRATED;
  if (signals.isOnV2 && signals.bornOnV2) return MIGRATION_STATUS.NATIVE;
  if (signals.isOnV2) return MIGRATION_STATUS.MIGRATED;
  return MIGRATION_STATUS.UNMIGRATED;
}

/** Whether a status represents a name that currently lives on ENS v2. */
export function isOnV2(status: MigrationStatus): boolean {
  return status === MIGRATION_STATUS.MIGRATED || status === MIGRATION_STATUS.NATIVE;
}

/** The subset of a v2-indexer (zigens) domain record that drives classification. */
export interface V2IndexerRecord {
  isMigrated?: boolean;
  owner?: { id?: string };
  ownerId?: string;
  /**
   * zigens exposes per-row provenance: "v1" = legacy ENS row, "v2" = ENSv2 row.
   * The indexer's schema is designed to serve BOTH, so "present in the v2 index"
   * must not be conflated with "on v2" — assert the protocol when it's present.
   */
  protocol?: string;
}

/**
 * Classify a domain record served by the **v2 indexer** (zigens). Single source
 * of truth shared by MetadataService and SyncService so they cannot drift:
 *  - `protocol: "v1"` row → the name is a legacy row in the index → `unmigrated`
 *  - RESERVED placeholder (owner == address(0)) → `unmigrated` (still v1-authoritative)
 *  - otherwise on v2; `isMigrated` distinguishes `migrated` from `native` (born on v2)
 */
export function classifyV2IndexerRecord(record: V2IndexerRecord): MigrationStatus {
  if (record.protocol === 'v1') {
    return classifyMigrationStatus({ isUnmigrated: true });
  }
  return classifyMigrationStatus({
    isOnV2: true,
    isReserved: isReservedOwner(record.owner?.id ?? record.ownerId),
    bornOnV2: record.isMigrated === false,
  });
}
