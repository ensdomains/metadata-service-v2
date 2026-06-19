// API request and response types
import type { MigrationStatus } from './index';

export interface MetadataRequest {
  network: 'mainnet' | 'sepolia';
  registryType: 'registry' | 'namewrapper';
  identifier: string;
}

export interface MetadataAttribute {
  trait_type: string;
  display_type: 'string' | 'number' | 'date';
  value: string | number;
}

export interface MetadataResponse {
  is_normalized: boolean;
  name: string;
  description: string;
  attributes: MetadataAttribute[];
  url: string;
  last_request_date: number;
  version: number;
  background_image: string;
  image: string;
  image_url: string;
}

export interface MigrationStatusResponse {
  name: string;
  status: MigrationStatus;
  l1Owner?: string;
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
  network?: 'mainnet' | 'sepolia';
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

export interface HealthResponse {
  service: string;
  version: string;
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  dependencies: {
    indexer: 'ok' | 'degraded' | 'error' | 'unknown';
    mainnet: 'ok' | 'degraded' | 'error' | 'unknown';
    sepolia: 'ok' | 'degraded' | 'error' | 'unknown';
  };
  latency?: {
    indexer: number | null;
  };
}

export interface ErrorResponse {
  error: string;
  details?: string;
  timestamp?: string;
}