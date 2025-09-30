-- Initial schema for ENS Metadata V2

-- Domains table for D1 fallback
CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    labelhash TEXT NOT NULL,
    is_migrated BOOLEAN NOT NULL DEFAULT FALSE,
    data_source TEXT NOT NULL,
    expiry_date TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_domains_name ON domains(name);
CREATE INDEX IF NOT EXISTS idx_domains_labelhash ON domains(labelhash);

-- Migration status tracking
CREATE TABLE IF NOT EXISTS migration_status (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('native', 'ejected', 'unmigrated', 'shadow')),
    chain_location TEXT NOT NULL CHECK (chain_location IN ('mainnet', 'namechain')),
    last_updated INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Registry hierarchy data
CREATE TABLE IF NOT EXISTS registry_hierarchy (
    name TEXT PRIMARY KEY,
    parent TEXT,
    level INTEGER NOT NULL,
    registry_type TEXT NOT NULL CHECK (registry_type IN ('registrar', 'wrapper', 'legacy')),
    contract_address TEXT,
    token_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (parent) REFERENCES registry_hierarchy(name)
);

-- ensnode sync data for fallback scenarios
CREATE TABLE IF NOT EXISTS ensnode_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data_type TEXT NOT NULL CHECK (data_type IN ('metadata', 'migration', 'hierarchy')),
    data_json TEXT NOT NULL,
    source_chain TEXT NOT NULL,
    sync_timestamp INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ensnode_name ON ensnode_sync(name);
CREATE INDEX IF NOT EXISTS idx_ensnode_type ON ensnode_sync(data_type);
CREATE INDEX IF NOT EXISTS idx_ensnode_chain ON ensnode_sync(source_chain);

-- Analytics and monitoring
CREATE TABLE IF NOT EXISTS request_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    name TEXT,
    network TEXT,
    status_code INTEGER NOT NULL,
    response_time_ms INTEGER NOT NULL,
    cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,
    user_agent TEXT,
    ip_address TEXT,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_endpoint ON request_analytics(endpoint);
CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON request_analytics(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_name ON request_analytics(name);

-- Cache invalidation tracking
CREATE TABLE IF NOT EXISTS cache_invalidation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    triggered_by TEXT NOT NULL CHECK (triggered_by IN ('webhook', 'manual', 'ttl_expired')),
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cache_invalidation_key ON cache_invalidation(cache_key);
CREATE INDEX IF NOT EXISTS idx_cache_invalidation_timestamp ON cache_invalidation(timestamp);

-- Triggers for updating timestamps
CREATE TRIGGER IF NOT EXISTS update_migration_status_timestamp
    AFTER UPDATE ON migration_status
    BEGIN
        UPDATE migration_status SET updated_at = strftime('%s', 'now') WHERE name = NEW.name;
    END;

CREATE TRIGGER IF NOT EXISTS update_registry_hierarchy_timestamp
    AFTER UPDATE ON registry_hierarchy
    BEGIN
        UPDATE registry_hierarchy SET updated_at = strftime('%s', 'now') WHERE name = NEW.name;
    END;