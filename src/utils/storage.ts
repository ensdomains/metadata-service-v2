export class StorageManager {
  constructor(private r2Bucket: R2Bucket) {}

  // Avatar operations
  async getAvatar(name: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    const key = `avatars/${name}`;
    const object = await this.r2Bucket.get(key);
    if (!object) return null;
    const data = await object.arrayBuffer();
    const contentType = object.httpMetadata?.contentType || 'image/png';
    return { data, contentType };
  }

  async setAvatar(name: string, data: ArrayBuffer, contentType: string): Promise<void> {
    const key = `avatars/${name}`;
    await this.r2Bucket.put(key, data, {
      httpMetadata: {
        contentType,
        cacheControl: 'public, max-age=86400' // 24 hours
      }
    });
  }

  // SVG operations
  async getSvgAsset(name: string): Promise<string | null> {
    const key = `svg/${name}.svg`;
    const object = await this.r2Bucket.get(key);
    return object ? await object.text() : null;
  }

  async setSvgAsset(name: string, svg: string): Promise<void> {
    const key = `svg/${name}.svg`;
    await this.r2Bucket.put(key, svg, {
      httpMetadata: {
        contentType: 'image/svg+xml',
        cacheControl: 'public, max-age=2592000' // 30 days
      }
    });
  }

  // Keyed SVG operations (for tiered image cache)
  // maxAgeSeconds: when set, returns null if the R2 object's uploaded timestamp
  // is older than this threshold, so the caller can fall through to origin
  // instead of serving an expired card through a binding read.
  // Returns the absolute uploadedAtMs so backfill callers can compute an
  // absolute KV expiration deadline — immune to body-latency clock drift.
  // When maxAgeSeconds is supplied, missing or invalid uploaded fails closed.
  async getSvgByKey(cacheKey: string, maxAgeSeconds?: number): Promise<{ svg: string; uploadedAtMs: number } | null> {
    const key = `svg/${cacheKey}.svg`;
    const object = await this.r2Bucket.get(key);
    if (!object) return null;
    const svg = await object.text();
    // uploaded is authoritative; if absent or invalid, we cannot enforce
    // TTL, so fail closed when a maxAge was requested.
    if (maxAgeSeconds !== undefined) {
      if (!object.uploaded) return null;
      const uploadedMs = object.uploaded.getTime();
      if (!isFinite(uploadedMs)) return null;
      const ageSeconds = (Date.now() - uploadedMs) / 1000;
      if (ageSeconds >= maxAgeSeconds) return null;
      return { svg, uploadedAtMs: uploadedMs };
    }
    // undefined maxAgeSeconds: unbounded backward compat
    return { svg, uploadedAtMs: object.uploaded ? object.uploaded.getTime() : 0 };
  }

  async setSvgByKey(cacheKey: string, svg: string, maxAge: number = 86400): Promise<void> {
    const key = `svg/${cacheKey}.svg`;
    await this.r2Bucket.put(key, svg, {
      httpMetadata: {
        contentType: 'image/svg+xml',
        cacheControl: `public, max-age=${maxAge}`,
      },
    });
  }

  // Delete all R2 objects matching a prefix. Paginates the R2 list cursor so
  // namespaces larger than one page (1000 objects) are fully purged.
  async deleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const listed = await this.r2Bucket.list({ prefix, limit: 1000, cursor });
      if (listed.objects.length > 0) {
        await Promise.all(listed.objects.map((obj) => this.r2Bucket.delete(obj.key)));
        deleted += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return deleted;
  }

  // Static assets operations
  async getStaticAsset(path: string): Promise<ArrayBuffer | null> {
    const key = `static/${path}`;
    const object = await this.r2Bucket.get(key);
    return object ? await object.arrayBuffer() : null;
  }

  async setStaticAsset(path: string, data: ArrayBuffer, contentType: string): Promise<void> {
    const key = `static/${path}`;
    await this.r2Bucket.put(key, data, {
      httpMetadata: {
        contentType,
        cacheControl: 'public, max-age=31536000' // 1 year
      }
    });
  }

  // Utility to check if asset exists
  async exists(key: string): Promise<boolean> {
    const object = await this.r2Bucket.head(key);
    return object !== null;
  }

  // Delete asset
  async delete(key: string): Promise<void> {
    await this.r2Bucket.delete(key);
  }

  // List assets with prefix
  async list(prefix: string, limit: number = 100): Promise<string[]> {
    const objects = await this.r2Bucket.list({ prefix, limit });
    return objects.objects.map(obj => obj.key);
  }

  // Get asset metadata
  async getMetadata(key: string): Promise<{
    size?: number;
    contentType?: string;
    lastModified?: Date;
  } | null> {
    const object = await this.r2Bucket.head(key);
    if (!object) return null;

    return {
      size: object.size,
      contentType: object.httpMetadata?.contentType,
      lastModified: object.uploaded
    };
  }
}