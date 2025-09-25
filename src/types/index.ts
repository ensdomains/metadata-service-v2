// Network types
export type NetworkName = 'mainnet' | 'namechain';

// ENS version types
export type ENSVersion = 'v1' | 'v2';

// Migration status types
export type MigrationStatus = 'native' | 'ejected' | 'unmigrated' | 'shadow';

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
  chain_location?: NetworkName;
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