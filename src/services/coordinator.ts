import { CacheManager } from '../utils/cache';
import { DatabaseManager } from '../utils/database';
import { StorageManager } from '../utils/storage';
import { Env } from '../index';

export class ServiceCoordinator {
  public cache: CacheManager;
  public database: DatabaseManager;
  public storage: StorageManager;

  constructor(public env: Env) {
    this.cache = new CacheManager(env.METADATA_CACHE, env.SVG_CACHE, env.DB);
    this.database = new DatabaseManager(env.DB);
    this.storage = new StorageManager(env.ASSET_BUCKET);
  }

  // Request deduplication using Durable Objects
  async getDeduper(id: string): Promise<DurableObjectStub> {
    const objectId = this.env.REQUEST_DEDUPER.idFromName(id);
    return this.env.REQUEST_DEDUPER.get(objectId);
  }

  // Deduplicate a request
  async dedupeRequest(key: string, maxAge: number): Promise<{
    status: 'pending' | 'completed' | 'error';
    data?: any;
  }> {
    const deduper = await this.getDeduper('global');
    const response = await deduper.fetch('/dedupe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, maxAge })
    });

    return await response.json();
  }

  // Complete a deduplicated request
  async completeRequest(key: string, data: any, maxAge: number): Promise<void> {
    const deduper = await this.getDeduper('global');
    await deduper.fetch('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, data, maxAge })
    });
  }

  // Error in a deduplicated request
  async errorRequest(key: string, error: string): Promise<void> {
    const deduper = await this.getDeduper('global');
    await deduper.fetch('/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, error })
    });
  }

  // Log request analytics
  async logRequest(data: {
    endpoint: string;
    name?: string;
    network?: string;
    status_code: number;
    response_time_ms: number;
    cache_hit?: boolean;
    fallback_used?: boolean;
    error_message?: string;
    request?: Request;
  }): Promise<void> {
    try {
      const analytics = {
        ...data,
        user_agent: data.request?.headers.get('user-agent') || undefined,
        ip_address: data.request?.headers.get('cf-connecting-ip') || undefined
      };
      
      await this.database.logRequest(analytics);
    } catch (error) {
      console.error('Failed to log request analytics:', error);
    }
  }

  // Health check for all services
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: {
      kv: boolean;
      d1: boolean;
      r2: boolean;
      durableObjects: boolean;
    };
  }> {
    const services = {
      kv: false,
      d1: false,
      r2: false,
      durableObjects: false
    };

    try {
      // Test KV
      await this.env.METADATA_CACHE.put('health-check', 'ok', { expirationTtl: 60 });
      const kvTest = await this.env.METADATA_CACHE.get('health-check');
      services.kv = kvTest === 'ok';
    } catch (error) {
      console.error('KV health check failed:', error);
    }

    try {
      // Test D1
      const d1Test = await this.env.DB.prepare('SELECT 1 as test').first();
      services.d1 = d1Test?.test === 1;
    } catch (error) {
      console.error('D1 health check failed:', error);
    }

    try {
      // Test R2
      await this.env.ASSET_BUCKET.put('health-check', 'ok');
      const r2Test = await this.env.ASSET_BUCKET.get('health-check');
      services.r2 = r2Test !== null;
      await this.env.ASSET_BUCKET.delete('health-check');
    } catch (error) {
      console.error('R2 health check failed:', error);
    }

    try {
      // Test Durable Objects
      const deduper = await this.getDeduper('health-check');
      const doTest = await deduper.fetch('/dedupe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'health-check', maxAge: 60 })
      });
      services.durableObjects = doTest.ok;
    } catch (error) {
      console.error('Durable Objects health check failed:', error);
    }

    const healthyCount = Object.values(services).filter(Boolean).length;
    const totalServices = Object.keys(services).length;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (healthyCount === totalServices) {
      status = 'healthy';
    } else if (healthyCount >= totalServices / 2) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return { status, services };
  }
}