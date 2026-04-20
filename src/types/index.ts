// Network types
export type NetworkName = 'mainnet' | 'sepolia';

// ENS version types
export type ENSVersion = 'v1' | 'v2';

// Migration status types
export type MigrationStatus = 'migrated' | 'native' | 'unmigrated';

// Registry type for routing
export type RegistryType = 'registrar' | 'wrapper' | 'legacy';

// Basic metadata structure
export interface Metadata {
  name: string;
  description: string;
  image: string;
  attributes: MetadataAttribute[];
  background_image?: string;
  is_normalized: boolean;
  version: ENSVersion;
  migration_status?: MigrationStatus;
  url?: string;
}

export interface MetadataAttribute {
  trait_type: string;
  display_type?: 'string' | 'number' | 'date';
  value: string | number;
}

// Cache configuration
export interface CacheConfig {
  ttl: number;
  layer: 'kv' | 'memory' | 'none';
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

// Error types
export class MetadataError extends Error {
  constructor(message: string, public code: string, public status: number = 500) {
    super(message);
    this.name = 'MetadataError';
  }
}

export class NetworkError extends MetadataError {
  constructor(network: string) {
    super(`Unsupported network: ${network}`, 'UNSUPPORTED_NETWORK', 400);
  }
}

export class NotFoundError extends MetadataError {
  constructor(resource: string) {
    super(`Resource not found: ${resource}`, 'NOT_FOUND', 404);
  }
}