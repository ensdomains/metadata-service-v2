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

  // Analytics operations
  async logRequest(data: {
    endpoint: string;
    name?: string;
    network?: string;
    status_code: number;
    response_time_ms: number;
    cache_hit?: boolean;
    fallback_used?: boolean;
    error_message?: string;
    user_agent?: string;
    ip_address?: string;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT INTO request_analytics 
      (endpoint, name, network, status_code, response_time_ms, cache_hit, fallback_used, error_message, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.endpoint,
      data.name || null,
      data.network || null,
      data.status_code,
      data.response_time_ms,
      data.cache_hit || false,
      data.fallback_used || false,
      data.error_message || null,
      data.user_agent || null,
      data.ip_address || null
    ).run();
  }

  // Get analytics for monitoring
  async getAnalytics(hours: number = 24): Promise<{
    total_requests: number;
    cache_hit_rate: number;
    fallback_usage_rate: number;
    avg_response_time: number;
    error_rate: number;
  }> {
    const since = Date.now() - (hours * 60 * 60 * 1000);
    
    const result = await this.db.prepare(`
      SELECT 
        COUNT(*) as total_requests,
        AVG(CASE WHEN cache_hit = 1 THEN 1.0 ELSE 0.0 END) * 100 as cache_hit_rate,
        AVG(CASE WHEN fallback_used = 1 THEN 1.0 ELSE 0.0 END) * 100 as fallback_usage_rate,
        AVG(response_time_ms) as avg_response_time,
        AVG(CASE WHEN status_code >= 400 THEN 1.0 ELSE 0.0 END) * 100 as error_rate
      FROM request_analytics
      WHERE timestamp >= ?
    `).bind(since).first();

    return {
      total_requests: (result?.total_requests as number) || 0,
      cache_hit_rate: (result?.cache_hit_rate as number) || 0,
      fallback_usage_rate: (result?.fallback_usage_rate as number) || 0,
      avg_response_time: (result?.avg_response_time as number) || 0,
      error_rate: (result?.error_rate as number) || 0
    };
  }
}