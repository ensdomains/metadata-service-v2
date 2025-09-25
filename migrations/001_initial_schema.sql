-- Initial schema for ENS Metadata V2 D1 database
-- This stores ensnode data locally for fast queries and fallback

-- Domain metadata from ensnode
CREATE TABLE domains (
  id TEXT PRIMARY KEY, -- namehash
  name TEXT NOT NULL UNIQUE,
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

  FOREIGN KEY (parent_id) REFERENCES domains(id)
);

-- Migration status tracking
CREATE TABLE migration_status (
  id TEXT PRIMARY KEY, -- namehash
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, -- 'native' | 'ejected' | 'unmigrated' | 'shadow'
  l1_owner TEXT,
  expiration_date TEXT, -- ISO string
  migration_date TEXT, -- ISO string when migration occurred

  -- Sync metadata
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1
);

-- Registry hierarchy data
CREATE TABLE registry_hierarchy (
  id TEXT PRIMARY KEY, -- namehash
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

  FOREIGN KEY (parent_id) REFERENCES registry_hierarchy(id),
  FOREIGN KEY (root_domain_id) REFERENCES domains(id)
);

-- Sync status tracking for ensnode operations
CREATE TABLE sync_status (
  operation TEXT PRIMARY KEY, -- 'domains' | 'migration' | 'hierarchy'
  last_sync INTEGER NOT NULL, -- Unix timestamp
  last_successful_sync INTEGER NOT NULL,
  sync_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Indexes for performance
CREATE INDEX idx_domains_name ON domains(name);
CREATE INDEX idx_domains_owner ON domains(owner_id);
CREATE INDEX idx_domains_parent ON domains(parent_id);
CREATE INDEX idx_domains_updated ON domains(last_updated);
CREATE INDEX idx_domains_migrated ON domains(is_migrated);

CREATE INDEX idx_migration_name ON migration_status(name);
CREATE INDEX idx_migration_status ON migration_status(status);
CREATE INDEX idx_migration_updated ON migration_status(last_updated);

CREATE INDEX idx_hierarchy_domain ON registry_hierarchy(root_domain_id);
CREATE INDEX idx_hierarchy_parent ON registry_hierarchy(parent_id);
CREATE INDEX idx_hierarchy_level ON registry_hierarchy(level);
CREATE INDEX idx_hierarchy_updated ON registry_hierarchy(last_updated);

-- Insert initial sync status
INSERT INTO sync_status (operation, last_sync, last_successful_sync) VALUES
  ('domains', 0, 0),
  ('migration', 0, 0),
  ('hierarchy', 0, 0);