import { describe, it, expect } from 'vitest';
import app from '../src/index';

describe('ENS Metadata V2', () => {
  it('should return health check', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    
    const data = await res.json() as any;
    expect(data.service).toBe('ENS Metadata V2');
    expect(data.status).toBe('ok');
    expect(data.version).toBe('2.0.0');
  });

  it('should return 404 for unknown routes', async () => {
    const res = await app.request('/unknown');
    expect(res.status).toBe(404);
    
    const data = await res.json() as any;
    expect(data.error).toBe('Not Found');
  });
});