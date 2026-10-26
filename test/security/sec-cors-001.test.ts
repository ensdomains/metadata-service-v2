import { describe, expect, it } from 'vitest';
import app from '../../src/index';
import { createMockEnv } from '../mocks/hono-env';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe('SEC-CORS-001: advertise only implemented cross-origin methods', () => {
  it('does not advertise PUT or DELETE for a service with only GET and POST routes', async () => {
    const response = await app.request(
      '/webhook',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://hostile.example',
          'Access-Control-Request-Method': 'DELETE',
        },
      },
      { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' } as never,
      ctx,
    );
    const methods = response.headers.get('Access-Control-Allow-Methods')
      ?.split(',')
      .map((method) => method.trim()) ?? [];

    expect(response.status).toBe(204);
    expect(methods).toEqual(['GET', 'POST']);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
