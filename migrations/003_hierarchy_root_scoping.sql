-- Fix registry_hierarchy primary key so storing one root domain does not
-- corrupt a sibling root that shares an ancestor.
--
-- The (network, id) PK in 002_network_scoping.sql means INSERT OR REPLACE moves
-- a shared ancestor row (e.g., eth) from one root_domain_id to another when two
-- domains share it. A name can belong to many domains' hierarchies, so the PK
-- must include root_domain_id to let each domain own its own ancestor rows.
--
-- D1 is a regenerable cache tier; DROP TABLE IF EXISTS + CREATE TABLE is safe
-- and follows the pattern established in 002_network_scoping.sql.
--
-- Finding: W8-D1-001
-- Safe to run repeatedly.

DROP TABLE IF EXISTS registry_hierarchy;

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
  PRIMARY KEY (network, id, root_domain_id)
);

CREATE INDEX idx_hierarchy_root ON registry_hierarchy(network, root_domain_id);
CREATE INDEX idx_hierarchy_root_level ON registry_hierarchy(network, root_domain_id, level);
CREATE INDEX idx_hierarchy_parent ON registry_hierarchy(network, parent_id);
CREATE INDEX idx_hierarchy_level ON registry_hierarchy(network, level);
CREATE INDEX idx_hierarchy_updated ON registry_hierarchy(network, last_updated);