-- Network-scope the D1 cache tables.
--
-- The original schema keyed every table on `id = namehash(name)` (and `name`
-- UNIQUE) with no network column. One worker serves both mainnet and sepolia
-- (the /:network/... routes) against a single D1 binding, and namehash is
-- identical across networks — so the two networks overwrote each other's rows.
--
-- The cached rows are derived/regenerable (D1 is a last-resort fallback, not a
-- source of truth), and the existing rows are network-ambiguous, so we drop and
-- recreate rather than backfill a `network` value we can't reconstruct. This
-- also serves as the cache wipe after the Sepolia v2 (June 2026) re-deployment.
--
-- Tables are recreated identically to 001_initial_schema.sql; keep the two in
-- sync. Safe to run repeatedly.

DROP TABLE IF EXISTS domains;
DROP TABLE IF EXISTS migration_status;
DROP TABLE IF EXISTS registry_hierarchy;
DROP TABLE IF EXISTS sync_status;

CREATE TABLE domains (
  network TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  label_name TEXT NOT NULL,
  labelhash TEXT NOT NULL,
  parent_id TEXT,
  owner_id TEXT,
  resolver_id TEXT,
  registrant_id TEXT,
  expiry_date TEXT,
  created_at TEXT,
  ttl INTEGER,
  is_migrated BOOLEAN NOT NULL DEFAULT 0,
  data_source TEXT NOT NULL DEFAULT 'ensnode',
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (network, id)
);

CREATE TABLE migration_status (
  network TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  expiration_date TEXT,
  migration_date TEXT,
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (network, id)
);

CREATE TABLE registry_hierarchy (
  network TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  resolver TEXT NOT NULL,
  level INTEGER NOT NULL,
  parent_id TEXT,
  root_domain_id TEXT NOT NULL,
  last_updated INTEGER NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (network, id)
);

CREATE TABLE sync_status (
  network TEXT NOT NULL,
  operation TEXT NOT NULL,
  last_sync INTEGER NOT NULL,
  last_successful_sync INTEGER NOT NULL,
  sync_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (network, operation)
);

CREATE UNIQUE INDEX idx_domains_network_name ON domains(network, name);
CREATE INDEX idx_domains_owner ON domains(network, owner_id);
CREATE INDEX idx_domains_parent ON domains(network, parent_id);
CREATE INDEX idx_domains_updated ON domains(network, last_updated);
CREATE INDEX idx_domains_migrated ON domains(network, is_migrated);

CREATE UNIQUE INDEX idx_migration_network_name ON migration_status(network, name);
CREATE INDEX idx_migration_status ON migration_status(network, status);
CREATE INDEX idx_migration_updated ON migration_status(network, last_updated);

CREATE INDEX idx_hierarchy_root ON registry_hierarchy(network, root_domain_id);
CREATE INDEX idx_hierarchy_parent ON registry_hierarchy(network, parent_id);
CREATE INDEX idx_hierarchy_level ON registry_hierarchy(network, level);
CREATE INDEX idx_hierarchy_updated ON registry_hierarchy(network, last_updated);
