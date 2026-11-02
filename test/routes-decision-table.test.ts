import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { createMockEnv } from './mocks/hono-env';

// Blind acceptance test (coachman oracle) for W3-ROUTES-011:
// the /registry-hierarchy route must return a 200 zero-owner placeholder
// when either checkExpiry or getRegistryHierarchy throws HTTPException(404)
// or HTTPException(503), with correct cache policies per status.
//
// This test exercises the route at its public HTTP interface so it can
// rank any lane's implementation. It is committed before product code
// changes and cherry-picked onto each lane's worktree at harvest.

// ---- fake caches.default (per-colo L0 edge cache) -----------------------------
const edgeStore = new Map<string, Response>();
let edgePuts = 0;
const keyOf = (r: RequestInfo | URL) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;
(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match(req: RequestInfo | URL) {
      return edgeStore.get(keyOf(req))?.clone() ?? null;
    },
    async put(req: RequestInfo | URL, res: Response) {
      edgePuts += 1;
      edgeStore.set(keyOf(req), res.clone());
    },
    async delete(req: RequestInfo | URL) {
      return edgeStore.delete(keyOf(req));
    },
  },
};

// WASM imports break under vite-node.
vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn(async () => '<svg/>'),
  initializeFont: vi.fn(async () => {}),
}));
vi.mock('../src/services/font', () => ({
  getSatoshiFont: vi.fn(async () => ({ buffer: new ArrayBuffer(0), base64: '' })),
}));

import app from '../src/index';
import { MetadataService } from '../src/services/metadata';
import { NETWORKS } from '../src/config/networks';

const ZERO = '0x0000000000000000000000000000000000000000';
const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;
const req = (path: string) =>
  app.request(
    path,
    undefined,
    createMockEnv() as unknown as Record<string, unknown>,
    ctx,
  );

describe('hierarchy route totality (S3) — blind oracle', () => {
  beforeEach(() => {
    edgeStore.clear();
    edgePuts = 0;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const hierarchyHttpExceptionFailures = ([
    [
      'expiry precheck',
      404,
      'http-precheck-404.eth',
      'public, max-age=300, stale-while-revalidate=60',
      'public, max-age=300',
    ],
    [
      'expiry precheck',
      503,
      'http-precheck-503.eth',
      'public, max-age=30',
      'public, max-age=30',
    ],
    [
      'direct hierarchy',
      404,
      'http-direct-404.eth',
      'public, max-age=300, stale-while-revalidate=60',
      'public, max-age=300',
    ],
    [
      'direct hierarchy',
      503,
      'http-direct-503.eth',
      'public, max-age=30',
      'public, max-age=30',
    ],
    [
      'direct hierarchy',
      404,
      'sub.deep-404.eth',
      'public, max-age=300, stale-while-revalidate=60',
      'public, max-age=300',
    ],
  ] as const).map(
    ([seam, status, name, clientCacheControl, edgeCacheControl]) => ({
      seam,
      status,
      name,
      clientCacheControl,
      edgeCacheControl,
    }),
  );

  it.each(hierarchyHttpExceptionFailures)(
    'gives S3 precedence over route-local HTTP $status from the $seam seam',
    async ({ seam, status, name, clientCacheControl, edgeCacheControl }) => {
      const failure = new HTTPException(status, {
        message: `hierarchy seam HTTP ${status}`,
      });
      const expiry = vi.spyOn(MetadataService.prototype, 'checkExpiry');
      const hierarchy = vi.spyOn(
        MetadataService.prototype,
        'getRegistryHierarchy',
      );
      if (seam === 'expiry precheck') {
        expiry.mockRejectedValue(failure);
      } else {
        expiry.mockResolvedValue(undefined);
        hierarchy.mockRejectedValue(failure);
      }

      const response = await req(
        `/registry-hierarchy/${name}?network=mainnet`,
      );
      const body = await response
        .clone()
        .json()
        .catch(() => ({})) as {
        name?: string;
        hierarchy?: Array<{ name: string; owner: string }>;
        _provenance?: string;
      };

      // Find the stored edge entry by URL.
      const storedResponse = [...edgeStore.values()].find(
        (r) => r.ok,
      ) as Response | undefined;
      const storedBody = storedResponse
        ? ((await storedResponse.clone().json().catch(() => ({}))) as Record<
            string,
            unknown
          >)
        : {};

      expect.soft(response.status).toBe(200);
      expect.soft(body.name).toBe(name);
      const resolver = NETWORKS.mainnet.contracts.resolver;
      const labels = name.split('.');
      expect.soft(body.hierarchy).toEqual(
        labels
          .map((_, i, arr) => arr.slice(i).join('.'))
          .reverse()
          .map((levelName, levelIndex) => ({
            name: levelName,
            owner: ZERO,
            resolver,
            level: levelIndex + 1,
          })),
      );
      expect.soft(body).not.toHaveProperty('_provenance');
      expect.soft(response.headers.get('Cache-Control')).toBe(clientCacheControl);
      expect.soft(expiry.mock.calls).toEqual([[name]]);
      if (seam === 'expiry precheck') {
        expect.soft(hierarchy).not.toHaveBeenCalled();
      } else {
        expect.soft(hierarchy.mock.calls).toEqual([[name]]);
        expect
          .soft(expiry.mock.invocationCallOrder[0])
          .toBeLessThan(hierarchy.mock.invocationCallOrder[0]!);
      }
      expect.soft(edgePuts).toBe(1);
      expect.soft(edgeStore.size).toBe(1);
      expect
        .soft(storedResponse?.headers.get('Cache-Control'))
        .toBe(edgeCacheControl);
      expect.soft(storedBody).not.toHaveProperty('_provenance');
    },
  );
});