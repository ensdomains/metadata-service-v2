// Network types — single source of truth lives in src/config/networks.ts.
import { type NetworkName, isNetworkName, SUPPORTED_NETWORKS, NETWORKS } from '../config/networks';
export { isNetworkName, SUPPORTED_NETWORKS, NETWORKS };
export type { NetworkName };

// Migration status types — the v1→v2 lifecycle of a name.
// See ../utils/migration.ts for the full model and how each value is derived.
// `ejected`/`shadow` from the v2 design doc are intentionally NOT modelled — the
// built system only has v1→v2 migration, all on Ethereum (see migration.ts).
export const MIGRATION_STATUS = {
  /** Still on ENS v1 (legacy registry). Not present in v2. */
  UNMIGRATED: 'unmigrated',
  /** Moved from v1 → v2 (indexer `migrated` flag set). */
  MIGRATED: 'migrated',
  /** Born on v2 — registered directly via the v2 registry, never on v1. */
  NATIVE: 'native',
} as const;

export type MigrationStatus = typeof MIGRATION_STATUS[keyof typeof MIGRATION_STATUS];

/** Runtime guard for untrusted `status` input (e.g. the image `?status=` param). */
export function isMigrationStatus(value: unknown): value is MigrationStatus {
  return typeof value === 'string' && (Object.values(MIGRATION_STATUS) as string[]).includes(value);
}

// Network configuration
export interface NetworkConfig {
  name: NetworkName;
  rpcUrl: string;
  contracts: {
    registry?: string;
    registrar?: string;
    nameWrapper?: string;
  };
}

// SVG cache entry stored in KV as JSON envelope
export interface SvgCacheEntry {
  svg: string;
  createdAt: number;    // epoch ms
  softTtl: number;      // seconds — serve but revalidate after this
  avatarHash: string;   // SHA-256 hex of avatar content (empty if no avatar)
  migrationStatus: string;
}

// Parameters used to build image cache keys
export interface ImageCacheParams {
  migrationStatus: string;
  width: number;
  height: number;
}
