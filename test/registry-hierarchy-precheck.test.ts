import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { NotFoundError } from '../src/services/errors';
import { CONTRACTS } from '../src/services/blockchain';
import { createMockEnv } from './mocks/hono-env';

// W3-ROUTES-009: registry hierarchy must remain total and degraded when its
// pre-service expiry gate reports a non-definitive miss.
//
// Before the fix, this test FAILS on the main baseline: the route returns 404
// error JSON with no Cache-Control and no edge write instead of the required
// 200 placeholder with Cache-Control: public, max-age=30.

// Track whether getRegistryHierarchy was called
let getRegistryHierarchyCalled = false;
let checkExpiryCalled = false;

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

vi.mock('../src/services/metadata', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/metadata')>();
  const { NotFoundError: NE } = await import('../src/services/errors');
  return {
    ...orig,
    MetadataService: class {
      async checkExpiry(_name: string) {
        checkExpiryCalled = true;
        throw new NE('precheck non-definitive miss', { definitive: false });
      }
      async getRegistryHierarchy(_name: string) {
        getRegistryHierarchyCalled = true;
        return { name: _name, hierarchy: [] };
      }
    },
  };
});

import app from '../src/index';

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const req = (path: string) => app.request(path, undefined, createMockEnv() as unknown as Record<string, unknown>, ctx);

describe('W3-ROUTES-009: registry-hierarchy precheck non-definitive miss', () => {
  beforeAll(() => {
    // Stub the global caches.default so edgeCachePut can be observed
    const cache = {
      match: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    };
    vi.stubGlobal('caches', { default: cache });
  });

  afterEach(() => {
    getRegistryHierarchyCalled = false;
    checkExpiryCalled = false;
  });

  it('returns 200 placeholder hierarchy when checkExpiry throws NotFoundError({ definitive: false })', async () => {
    const res = await req('/registry-hierarchy/precheck-non-definitive.eth?network=mainnet');

    // AC: 200 root-first two-level zero-owner placeholder
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe('precheck-non-definitive.eth');
    expect(body.hierarchy).toBeDefined();
    expect(Array.isArray(body.hierarchy)).toBe(true);

    const hierarchy = body.hierarchy as Array<Record<string, unknown>>;
    // root-first: eth at level 1, then the requested name at level 2
    expect(hierarchy.length).toBeGreaterThanOrEqual(2);
    expect(hierarchy[0].name).toBe('eth');
    expect(hierarchy[0].owner).toBe('0x0000000000000000000000000000000000000000');
    expect(hierarchy[0].resolver).toBe(CONTRACTS.mainnet.resolver);
    expect(hierarchy[1].name).toBe('precheck-non-definitive.eth');
    expect(hierarchy[1].owner).toBe('0x0000000000000000000000000000000000000000');
    expect(hierarchy[1].resolver).toBe(CONTRACTS.mainnet.resolver);

    // AC: literal client Cache-Control: public, max-age=30
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');

    // AC: no public _provenance
    expect(body._provenance).toBeUndefined();

    // AC: no hierarchy-service call (checkExpiry was, getRegistryHierarchy not)
    expect(checkExpiryCalled).toBe(true);
    expect(getRegistryHierarchyCalled).toBe(false);

    // AC: captured-edge Cache-Control is the same literal 30s header, not the
    // healthy hierarchy TTL, and the stored body keeps the default resolver.
    const cfCache = (globalThis as unknown as { caches: { default: { put: ReturnType<typeof vi.fn> } } }).caches.default;
    expect(cfCache.put).toHaveBeenCalled();
    const edge = cfCache.put.mock.calls.at(-1)?.[1] as Response;
    expect(edge.headers.get('Cache-Control')).toBe('public, max-age=30');
    const edgeBody = await edge.json() as { hierarchy: Array<{ resolver: string }> };
    expect(edgeBody.hierarchy[0].resolver).toBe(CONTRACTS.mainnet.resolver);
    expect(edgeBody.hierarchy[1].resolver).toBe(CONTRACTS.mainnet.resolver);

    const sepolia = await req('/registry-hierarchy/precheck-non-definitive.eth?network=sepolia');
    expect(sepolia.status).toBe(200);
    const sepoliaBody = await sepolia.json() as { hierarchy: Array<{ owner: string; resolver: string }> };
    expect(sepoliaBody.hierarchy[0].owner).toBe('0x0000000000000000000000000000000000000000');
    expect(sepoliaBody.hierarchy[0].resolver).toBe(CONTRACTS.sepolia.resolver);
    expect(sepoliaBody.hierarchy[1].resolver).toBe(CONTRACTS.sepolia.resolver);
  });
});
