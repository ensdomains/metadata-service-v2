// Use conditional import for Cloudflare Workers environment
const DurableObject = (() => {
  try {
    // This will work in Cloudflare Workers runtime
    return require("cloudflare:workers").DurableObject;
  } catch (error) {
    // Fallback for test environment
    return class DurableObject {
      constructor() {}
    };
  }
})();

export interface DedupeRequest {
  key: string;
  maxAge: number;
}

export interface DedupeResponse {
  status: 'pending' | 'completed' | 'error';
  data?: any;
  error?: string;
}

export class RequestDeduper extends DurableObject {
  private pendingRequests = new Map<string, Promise<any>>();
  private completedCache = new Map<string, { data: any; timestamp: number; maxAge: number }>();

  async dedupe(request: DedupeRequest): Promise<DedupeResponse> {
    const { key, maxAge } = request;
    const now = Date.now();

    // Check if we have a cached result that's still valid
    const cached = this.completedCache.get(key);
    if (cached && (now - cached.timestamp) < cached.maxAge) {
      return {
        status: 'completed',
        data: cached.data
      };
    }

    // Check if request is already pending
    const pending = this.pendingRequests.get(key);
    if (pending) {
      return {
        status: 'pending'
      };
    }

    // Remove expired cache entries
    this.cleanExpiredCache(now);
    
    return {
      status: 'pending'
    };
  }

  async complete(key: string, data: any, maxAge: number): Promise<void> {
    // Store in cache
    this.completedCache.set(key, {
      data,
      timestamp: Date.now(),
      maxAge
    });

    // Remove from pending
    this.pendingRequests.delete(key);
  }

  async error(key: string, error: string): Promise<void> {
    // Remove from pending
    this.pendingRequests.delete(key);
  }

  async setPending(key: string, promise: Promise<any>): Promise<void> {
    this.pendingRequests.set(key, promise);
  }

  private cleanExpiredCache(now: number): void {
    for (const [key, cached] of this.completedCache) {
      if ((now - cached.timestamp) >= cached.maxAge) {
        this.completedCache.delete(key);
      }
    }
  }

  // Handle HTTP requests directly to the Durable Object
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (request.method === 'POST' && url.pathname === '/dedupe') {
      const body = await request.json() as DedupeRequest;
      const result = await this.dedupe(body);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/complete') {
      const body = await request.json() as { key: string; data: any; maxAge: number };
      await this.complete(body.key, body.data, body.maxAge);
      return new Response('OK');
    }

    if (request.method === 'POST' && url.pathname === '/error') {
      const body = await request.json() as { key: string; error: string };
      await this.error(body.key, body.error);
      return new Response('OK');
    }

    return new Response('Not Found', { status: 404 });
  }
}