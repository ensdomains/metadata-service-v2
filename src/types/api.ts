// API request and response types
export interface MetadataRequest {
  network: 'mainnet' | 'namechain';
  registryType: 'registry' | 'namewrapper';
  identifier: string;
}

export interface MetadataResponse {
  name: string;
  tokenId: string;
  version: 'v1' | 'v2';
  network: string;
  description: string;
  image: string;
  attributes: Array<{
    trait_type: string;
    value: string | number;
  }>;
  background_image?: string;
  external_url?: string;
  animation_url?: string;
}

export interface MigrationStatusResponse {
  name: string;
  status: 'migrated' | 'native' | 'ejected' | 'unmigrated' | 'shadow';
  l1Owner?: string;
  l2Owner?: string;
  migrationDate?: string;
  expirationDate?: string;
}

export interface RegistryHierarchyResponse {
  name: string;
  hierarchy: Array<{
    name: string;
    owner: string;
    resolver: string;
    level: number;
  }>;
}

export interface BatchMetadataRequest {
  names: string[];
  network?: 'mainnet' | 'namechain';
}

export interface BatchMetadataResponse {
  results: Array<{
    name: string;
    metadata?: MetadataResponse;
    error?: string;
  }>;
  total: number;
  successful: number;
  failed: number;
}

export interface CrossChainSyncResponse {
  name: string;
  mainnet: {
    exists: boolean;
    metadata?: MetadataResponse;
    error?: string;
  };
  namechain: {
    exists: boolean;
    metadata?: MetadataResponse;
    error?: string;
  };
  consistent: boolean;
  differences: string[];
  recommendation: 'migrated' | 'unmigrated' | 'inconsistent' | 'error';
}

export interface HealthResponse {
  service: string;
  version: string;
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  dependencies: {
    ensnode: 'ok' | 'degraded' | 'error' | 'unknown';
    mainnet: 'ok' | 'degraded' | 'error' | 'unknown';
    namechain: 'ok' | 'degraded' | 'error' | 'unknown';
  };
}

export interface ErrorResponse {
  error: string;
  details?: string;
  timestamp?: string;
}