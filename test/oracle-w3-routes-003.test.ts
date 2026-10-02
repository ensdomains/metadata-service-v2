import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/services/errors';
import { FallbackService } from '../src/services/fallback';
import { MetadataService } from '../src/services/metadata';
import { CONTRACTS } from '../src/services/blockchain';
import { createMockEnv } from './mocks/hono-env';

// W3-ROUTES-003 blind regression. The finding's input is this request, not a
// helper call: a non-definitive hierarchy miss with D1 missing must stay a
// degraded 200, not a healthy cached success.

const ZERO = '0x0000000000000000000000000000000000000000';
const RESOLVER = CONTRACTS.sepolia.resolver;
const PATH = '/registry-hierarchy/non-definitive.eth?network=sepolia';
const URL = `http://localhost${PATH}`;

const placeholder = {
  name: 'non-definitive.eth',
  hierarchy: [
    { name: 'eth', owner: ZERO, resolver: RESOLVER, level: 1 },
    { name: 'non-definitive.eth', owner: ZERO, resolver: RESOLVER, level: 2 },
  ],
};

const edgeStore = new Map<string, Response>();
const keyOf = (r: RequestInfo | URL) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;

(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match(req: RequestInfo | URL) {
      const hit = edgeStore.get(keyOf(req));
      return hit ? hit.clone() : undefined;
    },
    async put(req: RequestInfo | URL, res: Response) {
      edgeStore.set(keyOf(req), res.clone());
    },
    async delete(req: RequestInfo | URL) {
      return edgeStore.delete(keyOf(req));
    },
  },
};

import app from '../src/index';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  };
}

function hasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  const record = value as Record<string, unknown>;
  return Object.keys(record).includes(key) || Object.values(record).some((item) => hasKey(item, key));
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}

beforeEach(() => {
  edgeStore.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('W3-ROUTES-003 non-definitive hierarchy miss', () => {
  it('publishes the zero-owner placeholder as degraded, not as a healthy cache success', async () => {
    const kv = memoryKv();
    const env = {
      ...createMockEnv(),
      DB: undefined,
      METADATA_CACHE: kv,
    } as unknown as Record<string, unknown>;
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockResolvedValue(undefined);
    const hierarchy = vi.spyOn(FallbackService.prototype, 'getRegistryHierarchy')
      .mockRejectedValue(new NotFoundError('Hierarchy for non-definitive.eth not found in any source', { definitive: false }));

    const first = makeCtx();
    const res = await app.request(PATH, undefined, env, first.ctx);
    await first.flush();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(placeholder);
    expect(hasKey(body, '_provenance')).toBe(false);
    expect.soft(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect.soft(edgeStore.get(URL)?.headers.get('Cache-Control')).toBe('public, max-age=30');

    edgeStore.clear();
    const second = makeCtx();
    const again = await app.request(PATH, undefined, env, second.ctx);
    await second.flush();
    const againBody = await again.json();

    expect(hierarchy).toHaveBeenCalledTimes(1);
    expect(again.status).toBe(200);
    expect(againBody).toEqual(placeholder);
    expect(hasKey(againBody, '_provenance')).toBe(false);
    expect.soft(again.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect.soft(edgeStore.get(URL)?.headers.get('Cache-Control')).toBe('public, max-age=30');
  });
});
