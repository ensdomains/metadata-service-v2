-- Initial schema for ENS Metadata V2 D1 database
-- This stores ensnode data locally for fast queries and fallback.
--
-- All rows are network-scoped: one worker serves both mainnet and sepolia via
-- the /:network/... routes against a single D1 binding, and namehash(name) is
-- identical across networks (e.g. fox.eth). Without a `network` column the two
-- networks collide on the same primary key. Every table therefore carries
-- `network` and keys on (network, id) / (network, operation).

-- Domain metadata from ensnode
CREATE TABLE IF NOT EXISTS domains (
  network TEXT NOT NULL, -- 'mainnet' | 'sepolia'
  id TEXT NOT NULL, -- namehash (unique only within a network)
  name TEXT NOT NULL,
  label_name TEXT NOT NULL,
  labelhash TEXT NOT NULL,
  parent_id TEXT,
  owner_id TEXT,
  resolver_id TEXT,
  registrant_id TEXT,
  expiry_date TEXT, -- ISO string
  created_at TEXT, -- ISO string
  ttl INTEGER,
  is_migrated BOOLEAN NOT NULL DEFAULT 0,

  -- Metadata fields
  data_source TEXT NOT NULL DEFAULT 'ensnode', -- 'ensnode' | 'blockchain'
  last_updated INTEGER NOT NULL, -- Unix timestamp
  sync_version INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (network, id)
);

-- Migration status tracking
CREATE TABLE IF NOT EXISTS migration_status (
  network TEXT NOT NULL, -- 'mainnet' | 'sepolia'
  id TEXT NOT NULL, -- namehash
  name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'unmigrated' | 'migrated' | 'native' (see src/utils/migration.ts)
  owner TEXT, -- current owner (v1 or v2 registry, whichever holds the name)
  expiration_date TEXT, -- ISO string
  migration_date TEXT, -- ISO string when migration occurred

  -- Sync metadata
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (network, id)
);

-- Registry hierarchy data
CREATE TABLE IF NOT EXISTS registry_hierarchy (
  network TEXT NOT NULL, -- 'mainnet' | 'sepolia'
  id TEXT NOT NULL, -- namehash
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  resolver TEXT NOT NULL,
  level INTEGER NOT NULL,
  parent_id TEXT,

  -- Which domain this hierarchy belongs to
  root_domain_id TEXT NOT NULL,

  -- Sync metadata
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (network, id)
);

-- Sync status tracking for ensnode operations
CREATE TABLE IF NOT EXISTS sync_status (
  network TEXT NOT NULL, -- 'mainnet' | 'sepolia'
  operation TEXT NOT NULL, -- 'domains' | 'migration' | 'hierarchy'
  last_sync INTEGER NOT NULL, -- Unix timestamp
  last_successful_sync INTEGER NOT NULL,
  sync_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  PRIMARY KEY (network, operation)
);

-- Indexes for performance (all network-prefixed; name lookups covered by the
-- unique indexes below).
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_network_name ON domains(network, name);
CREATE INDEX IF NOT EXISTS idx_domains_owner ON domains(network, owner_id);
CREATE INDEX IF NOT EXISTS idx_domains_parent ON domains(network, parent_id);
CREATE INDEX IF NOT EXISTS idx_domains_updated ON domains(network, last_updated);
CREATE INDEX IF NOT EXISTS idx_domains_migrated ON domains(network, is_migrated);

CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_network_name ON migration_status(network, name);
CREATE INDEX IF NOT EXISTS idx_migration_status ON migration_status(network, status);
CREATE INDEX IF NOT EXISTS idx_migration_updated ON migration_status(network, last_updated);

CREATE INDEX IF NOT EXISTS idx_hierarchy_root ON registry_hierarchy(network, root_domain_id);
CREATE INDEX IF NOT EXISTS idx_hierarchy_parent ON registry_hierarchy(network, parent_id);
CREATE INDEX IF NOT EXISTS idx_hierarchy_level ON registry_hierarchy(network, level);
CREATE INDEX IF NOT EXISTS idx_hierarchy_updated ON registry_hierarchy(network, last_updated);
