// Network types
export type NetworkName = 'mainnet' | 'sepolia';

// Migration status types
export const MIGRATION_STATUS = {
  MIGRATED: 'migrated',
  NATIVE: 'native',
  UNMIGRATED: 'unmigrated',
} as const;

export type MigrationStatus = typeof MIGRATION_STATUS[keyof typeof MIGRATION_STATUS];

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
