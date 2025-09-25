import { MigrationStatus, NetworkName } from '../types';

export class DatabaseManager {
  constructor(private db: D1Database) {}

  // Migration status operations
  async getMigrationStatus(name: string): Promise<{
    status: MigrationStatus;
    chain_location: NetworkName;
    last_updated: number;
  } | null> {
    const result = await this.db.prepare(`
      SELECT status, chain_location, last_updated
      FROM migration_status
      WHERE name = ?
    `).bind(name).first();

    return result ? {
      status: result.status as MigrationStatus,
      chain_location: result.chain_location as NetworkName,
      last_updated: result.last_updated as number
    } : null;
  }

  async setMigrationStatus(
    name: string,
    status: MigrationStatus,
    chainLocation: NetworkName,
    lastUpdated: number
  ): Promise<void> {
    await this.db.prepare(`
      INSERT OR REPLACE INTO migration_status (name, status, chain_location, last_updated)
      VALUES (?, ?, ?, ?)
    `).bind(name, status, chainLocation, lastUpdated).run();
  }

  // Registry hierarchy operations
  async getRegistryHierarchy(name: string): Promise<{
    parent: string | null;
    level: number;
    registry_type: string;
    contract_address: string | null;
    token_id: string | null;
  } | null> {
    const result = await this.db.prepare(`
      SELECT parent, level, registry_type, contract_address, token_id
      FROM registry_hierarchy
      WHERE name = ?
    `).bind(name).first();

    return result ? {
      parent: result.parent as string | null,
      level: result.level as number,
      registry_type: result.registry_type as string,
      contract_address: result.contract_address as string | null,
      token_id: result.token_id as string | null
    } : null;
  }

  async setRegistryHierarchy(data: {
    name: string;
    parent: string | null;
    level: number;
    registry_type: string;
    contract_address: string | null;
    token_id: string | null;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT OR REPLACE INTO registry_hierarchy 
      (name, parent, level, registry_type, contract_address, token_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      data.name,
      data.parent,
      data.level,
      data.registry_type,
      data.contract_address,
      data.token_id
    ).run();
  }

  // ensnode sync data operations
  async getEnsnodeSync(name: string, dataType: string): Promise<any | null> {
    const result = await this.db.prepare(`
      SELECT data_json
      FROM ensnode_sync
      WHERE name = ? AND data_type = ?
      ORDER BY sync_timestamp DESC
      LIMIT 1
    `).bind(name, dataType).first();

    if (!result) return null;

    try {
      return JSON.parse(result.data_json as string);
    } catch (error) {
      console.error('Failed to parse ensnode sync data:', error);
      return null;
    }
  }

  async setEnsnodeSync(
    name: string,
    dataType: string,
    data: any,
    sourceChain: string
  ): Promise<void> {
    await this.db.prepare(`
      INSERT INTO ensnode_sync (name, data_type, data_json, source_chain, sync_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).bind(name, dataType, JSON.stringify(data), sourceChain, Date.now()).run();
  }

}