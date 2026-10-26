import { describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import { createMockEnv } from '../mocks/hono-env';

const MAX_BATCH_BODY_BYTES = 64 * 1024;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = () => ({ ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' }) as never;

function paddedBody(size: number): string {
  const empty = JSON.stringify({ names: [], padding: '' });
  return JSON.stringify({ names: [], padding: 'x'.repeat(size - empty.length) });
}

function chunked(bytes: Uint8Array, chunkSize: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = bytes.subarray(pulled * chunkSize, (pulled + 1) * chunkSize);
      pulled++;
      if (chunk.length === 0) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return { body, pulls: () => pulled };
}

async function fetchRaw(body: BodyInit, headers: HeadersInit): Promise<Response> {
  const request = new Request('http://localhost/batch-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return app.fetch(request, env(), ctx);
}

describe('POST /batch-metadata body cap', () => {
  it('accepts a body at the 64 KiB boundary and rejects a declared over-limit body without reading it', async () => {
    const atCap = paddedBody(MAX_BATCH_BODY_BYTES);
    expect(new TextEncoder().encode(atCap)).toHaveLength(MAX_BATCH_BODY_BYTES);
    const accepted = await fetchRaw(atCap, { 'Content-Length': String(MAX_BATCH_BODY_BYTES) });
    expect(accepted.status).toBe(400); // parsed normally, then rejected because names is empty

    const over = paddedBody(MAX_BATCH_BODY_BYTES + 1);
    const request = new Request('http://localhost/batch-metadata', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_BATCH_BODY_BYTES + 1),
      },
      body: over,
    });
    const getReader = vi.spyOn(request.body!, 'getReader');
    const rejected = await app.fetch(request, env(), ctx);
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: 'Payload too large' });
    expect(getReader).not.toHaveBeenCalled();
  });

  it('stops a chunked or lying-length body immediately after it crosses the cap', async () => {
    for (const declaredLength of [undefined, '1']) {
      const bytes = new TextEncoder().encode(paddedBody(1024 * 1024));
      const stream = chunked(bytes, 16 * 1024);
      const response = await fetchRaw(
        stream.body,
        declaredLength ? { 'Content-Length': declaredLength } : {},
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Payload too large' });
      expect(stream.pulls()).toBeLessThanOrEqual(6);
    }
  });
});
