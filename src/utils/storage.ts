export class StorageManager {
  constructor(private r2Bucket: R2Bucket) {}

  // Avatar operations
  async getAvatar(name: string): Promise<ArrayBuffer | null> {
    const key = `avatars/${name}`;
    const object = await this.r2Bucket.get(key);
    return object ? await object.arrayBuffer() : null;
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
  async getSvgByKey(cacheKey: string): Promise<string | null> {
    const key = `svg/${cacheKey}.svg`;
    const object = await this.r2Bucket.get(key);
    return object ? await object.text() : null;
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

  // Delete all R2 objects matching a prefix
  async deleteByPrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix, 1000);
    if (keys.length === 0) return 0;
    await Promise.all(keys.map((key) => this.r2Bucket.delete(key)));
    return keys.length;
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