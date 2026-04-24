// Webhook handler for ensnode cache invalidation
import type { Context } from 'hono';
import { CacheService, CacheKeys } from './cache';
import { validateEnsName } from '../utils/ens';
import type { StorageManager } from '../utils/storage';

// Webhook payload types
export interface EnsnodeWebhookEvent {
  event: 'domain.updated' | 'domain.transferred' | 'domain.expired' | 'domain.renewed';
  domain: {
    name: string;
    tokenId?: string;
    owner?: string;
    resolver?: string;
    expiry?: string;
  };
  timestamp: string;
  network: 'mainnet' | 'sepolia';
}

export interface WebhookValidationConfig {
  secret?: string;
  allowedIPs?: string[];
  requireAuth: boolean;
}

export class WebhookService {
  private svgCacheKv?: KVNamespace;
  private metadataCacheKv?: KVNamespace;
  private storageManager?: StorageManager;

  constructor(
    private cache: CacheService,
    private config: WebhookValidationConfig = { requireAuth: false },
    svgCacheKv?: KVNamespace,
    storageManager?: StorageManager,
    metadataCacheKv?: KVNamespace,
  ) {
    this.svgCacheKv = svgCacheKv;
    this.storageManager = storageManager;
    this.metadataCacheKv = metadataCacheKv;
  }

  // Handle incoming webhook
  async handleWebhook(c: Context): Promise<Response> {
    try {
      // Validate request
      const validationResult = await this.validateRequest(c);
      if (!validationResult.valid) {
        return c.json({ error: validationResult.error }, (validationResult.status || 400) as any);
      }

      // Parse webhook payload
      const payload = await c.req.json() as EnsnodeWebhookEvent;

      // Validate payload structure
      const payloadValidation = this.validatePayload(payload);
      if (!payloadValidation.valid) {
        return c.json({ error: payloadValidation.error }, 400);
      }

      // Process webhook event
      await this.processWebhookEvent(payload);

      // Return success response
      return c.json({
        status: 'success',
        processed: true,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      console.error('Webhook processing error:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  }

  // Validate webhook request
  private async validateRequest(c: Context): Promise<{
    valid: boolean;
    error?: string;
    status?: number;
  }> {
    // Check if authentication is required
    if (!this.config.requireAuth) {
      return { valid: true };
    }

    // Validate IP allowlist if configured
    if (this.config.allowedIPs && this.config.allowedIPs.length > 0) {
      const clientIP = c.req.header('CF-Connecting-IP') ||
                       c.req.header('X-Forwarded-For') ||
                       'unknown';

      if (!this.config.allowedIPs.includes(clientIP)) {
        return {
          valid: false,
          error: 'Unauthorized IP address',
          status: 403,
        };
      }
    }

    // Validate webhook signature if secret is configured
    if (this.config.secret) {
      const signature = c.req.header('X-Ensnode-Signature');
      if (!signature) {
        return {
          valid: false,
          error: 'Missing webhook signature',
          status: 401,
        };
      }

      const body = await c.req.text();
      const expectedSignature = await this.calculateSignature(body, this.config.secret);

      if (signature !== expectedSignature) {
        return {
          valid: false,
          error: 'Invalid webhook signature',
          status: 401,
        };
      }
    }

    return { valid: true };
  }

  // Validate webhook payload structure
  private validatePayload(payload: any): {
    valid: boolean;
    error?: string;
  } {
    if (!payload || typeof payload !== 'object') {
      return { valid: false, error: 'Invalid payload format' };
    }

    // Check required fields
    const requiredFields = ['event', 'domain', 'timestamp', 'network'];
    for (const field of requiredFields) {
      if (!(field in payload)) {
        return { valid: false, error: `Missing required field: ${field}` };
      }
    }

    // Validate event type
    const validEvents = ['domain.updated', 'domain.transferred', 'domain.expired', 'domain.renewed'];
    if (!validEvents.includes(payload.event)) {
      return { valid: false, error: 'Invalid event type' };
    }

    // Validate domain object
    if (!payload.domain || !payload.domain.name) {
      return { valid: false, error: 'Missing domain name' };
    }

    // Validate domain name format
    if (!validateEnsName(payload.domain.name)) {
      return { valid: false, error: 'Invalid domain name format' };
    }

    // Validate network
    if (!['mainnet', 'sepolia'].includes(payload.network)) {
      return { valid: false, error: 'Invalid network' };
    }

    return { valid: true };
  }

  // Process webhook event and invalidate cache
  private async processWebhookEvent(event: EnsnodeWebhookEvent): Promise<void> {
    const domainName = event.domain.name;

    console.log(`Processing webhook event: ${event.event} for ${domainName}`);

    try {
      // Invalidate domain-specific cache entries for all networks
      const networks = ['mainnet', 'sepolia'];
      await Promise.all(networks.flatMap(net => [
        this.cache.delete(CacheKeys.domain(domainName, net)),
        this.cache.delete(CacheKeys.migrationStatus(domainName, net)),
        this.cache.delete(CacheKeys.hierarchy(domainName, net)),
      ]));

      // Invalidate batch caches that might include this domain
      await this.invalidateBatchCaches(domainName);

      // Handle specific event types
      switch (event.event) {
        case 'domain.transferred':
          // Invalidate owner-related caches
          if (event.domain.owner) {
            await this.invalidateOwnerCaches(event.domain.owner);
          }
          break;

        case 'domain.expired':
          // Invalidate expiry-related caches
          await this.invalidateExpiryCaches();
          break;

        case 'domain.renewed':
          // Domain renewed - invalidate expiry and status caches
          await this.invalidateExpiryCaches();
          break;

        case 'domain.updated':
          // General update - already handled above
          break;
      }

      // Invalidate endpoint-level metadata cache (meta:*:*:name keys)
      await this.invalidateMetadataCache(domainName);

      // Invalidate image caches (KV SVG + R2 avatar/SVG)
      await this.invalidateImageCaches(domainName);

      console.log(`Cache invalidation completed for ${domainName}`);

    } catch (error) {
      console.error(`Failed to process webhook for ${domainName}:`, error);
      throw error;
    }
  }

  // Invalidate endpoint-level metadata cache entries for a domain
  private async invalidateMetadataCache(domainName: string): Promise<void> {
    if (!this.metadataCacheKv) return;
    try {
      // MetadataCacheService writes keys as meta:{network}:{registryType}:{name}
      const list = await this.metadataCacheKv.list({ prefix: 'meta:' });
      const matching = list.keys.filter(k => k.name.endsWith(`:${domainName}`));
      if (matching.length > 0) {
        await Promise.all(matching.map(k => this.metadataCacheKv!.delete(k.name)));
      }
    } catch (err) {
      console.warn(`Failed to invalidate metadata cache for ${domainName}:`, err);
    }
  }

  // Invalidate image caches (SVG KV entries + R2 avatar/SVG assets)
  private async invalidateImageCaches(domainName: string): Promise<void> {
    // KV: list and delete all SVG cache entries for this domain
    if (this.svgCacheKv) {
      try {
        const prefix = `svg:${domainName}:`;
        const list = await this.svgCacheKv.list({ prefix });
        if (list.keys.length > 0) {
          await Promise.all(list.keys.map((k) => this.svgCacheKv!.delete(k.name)));
        }
      } catch (err) {
        console.warn(`Failed to invalidate SVG KV cache for ${domainName}:`, err);
      }
    }

    // R2: delete avatar and SVG assets for this domain
    if (this.storageManager) {
      try {
        await Promise.all([
          this.storageManager.delete(`avatars/${domainName}`),
          this.storageManager.deleteByPrefix(`svg/svg:${domainName}:`),
        ]);
      } catch (err) {
        console.warn(`Failed to invalidate R2 assets for ${domainName}:`, err);
      }
    }
  }

  // Invalidate batch caches that might contain the domain
  private async invalidateBatchCaches(domainName: string): Promise<void> {
    // This is a simplified approach - in production you might want to
    // track which batch caches contain which domains
    try {
      await this.cache.deleteByPrefix('batch:', 'ensnode');
    } catch (error) {
      console.warn('Failed to invalidate batch caches:', error);
    }
  }

  // Invalidate caches related to a specific owner
  private async invalidateOwnerCaches(owner: string): Promise<void> {
    // Invalidate owner-specific queries if cached
    // This would depend on your caching strategy for owner queries
    try {
      await this.cache.deleteByPrefix(`owner:${owner.toLowerCase()}`, 'ensnode');
    } catch (error) {
      console.warn('Failed to invalidate owner caches:', error);
    }
  }

  // Invalidate expiry-related caches
  private async invalidateExpiryCaches(): Promise<void> {
    try {
      await this.cache.deleteByPrefix('expiring:', 'ensnode');
      await this.cache.deleteByPrefix('recent:', 'ensnode');
    } catch (error) {
      console.warn('Failed to invalidate expiry caches:', error);
    }
  }

  // Calculate HMAC signature for webhook validation
  private async calculateSignature(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const hashArray = Array.from(new Uint8Array(signature));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return `sha256=${hashHex}`;
  }
}