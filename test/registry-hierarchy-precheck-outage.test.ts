import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEnv } from './mocks/hono-env';

// W3-ROUTES-007: GET /registry-hierarchy/:name must stay total when the
// pre-service expiry check cannot read upstream state. An UpstreamError from
// MetadataService.checkExpiry() used to become a 503 with no placeholder and
// no edge write. The route must instead return the two-level zero-owner
// placeholder, short-cache it for 30s on the client and at the edge, and
// never call the hierarchy service after the failed pre-check.

interface EdgeWrite {
  url: string;
  response: Response;
}

const edgeWrites: EdgeWrite[] = [];
const keyOf = (r: RequestInfo | URL | Request) =>
  typeof r === 'string' ? r : r instanceof URL ? r.href : (r as Request).url;

(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match() {
      return undefined;
    },
    async put(req: RequestInfo | URL, res: Response) {
      edgeWrites.push({ url: keyOf(req), response: res });
    },
    async delete() {
      return true;
    },
  },
};

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
  },
}));

import { MetadataService } from '../src/services/metadata';
import { BlockchainService } from '../src/services/blockchain';
import { UpstreamError, RequestDeadlineError } from '../src/services/errors';
import app from '../src/index';

const ZERO_OWNER = '0x0000000000000000000000000000000000000000';
const MAINNET_RESOLVER = '0xF29100983E058B709F3D539b0c765937B804AC15';
const PATH = '/registry-hierarchy/precheck-outage.eth?network=mainnet';
const env = { ...createMockEnv(), RATE_LIMIT_DISABLED: 'true' } as unknown as Record<string, unknown>;

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
  edgeWrites.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /registry-hierarchy/:name when checkExpiry throws UpstreamError', () => {
  it('returns a 200 two-level zero-owner placeholder, short-cached at the client and edge, without calling the hierarchy service', async () => {
    vi.spyOn(MetadataService.prototype, 'checkExpiry').mockRejectedValue(
      new UpstreamError('expiry precheck unreachable'),
    );
    const getRegistryHierarchy = vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');

    const { ctx, flush } = makeCtx();
    const res = await app.request(PATH, undefined, env, ctx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(await res.json()).toEqual({
      name: 'precheck-outage.eth',
      hierarchy: [
        {
          name: 'eth',
          owner: ZERO_OWNER,
          resolver: MAINNET_RESOLVER,
          level: 1,
        },
        {
          name: 'precheck-outage.eth',
          owner: ZERO_OWNER,
          resolver: MAINNET_RESOLVER,
          level: 2,
        },
      ],
    });

    expect(edgeWrites).toHaveLength(1);
    expect(edgeWrites[0].url).toBe(`http://localhost${PATH}`);
    expect(edgeWrites[0].response.status).toBe(200);
    expect(edgeWrites[0].response.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(await edgeWrites[0].response.clone().json()).toEqual({
      name: 'precheck-outage.eth',
      hierarchy: [
        {
          name: 'eth',
          owner: ZERO_OWNER,
          resolver: MAINNET_RESOLVER,
          level: 1,
        },
        {
          name: 'precheck-outage.eth',
          owner: ZERO_OWNER,
          resolver: MAINNET_RESOLVER,
          level: 2,
        },
      ],
    });

    expect(getRegistryHierarchy).not.toHaveBeenCalled();
  });
});

const PLACEHOLDER = {
  name: 'precheck-outage.eth',
  hierarchy: [
    {
      name: 'eth',
      owner: ZERO_OWNER,
      resolver: MAINNET_RESOLVER,
      level: 1,
    },
    {
      name: 'precheck-outage.eth',
      owner: ZERO_OWNER,
      resolver: MAINNET_RESOLVER,
      level: 2,
    },
  ],
};

async function expectShortCachedPlaceholder(path: string, body: typeof PLACEHOLDER) {
  const getRegistryHierarchy = vi.spyOn(MetadataService.prototype, 'getRegistryHierarchy');
  const { ctx, flush } = makeCtx();
  const res = await app.request(path, undefined, env, ctx);
  await flush();

  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
  expect(await res.json()).toEqual(body);
  expect(edgeWrites).toHaveLength(1);
  expect(edgeWrites[0].response.status).toBe(200);
  expect(edgeWrites[0].response.headers.get('Cache-Control')).toBe('public, max-age=30');
  expect(await edgeWrites[0].response.clone().json()).toEqual(body);
  expect(getRegistryHierarchy).not.toHaveBeenCalled();
}

describe('GET /registry-hierarchy/:name when the real expiry pre-check cannot read upstream state', () => {
  it('does not fail open on mainnet: a getExpiry UpstreamError becomes the 30s placeholder and does not call hierarchy', async () => {
    vi.spyOn(BlockchainService.prototype, 'getExpiry').mockRejectedValue(
      new UpstreamError('all RPCs failed'),
    );

    await expectShortCachedPlaceholder(PATH, PLACEHOLDER);
  });

  it('does not fail open on sepolia: a getV2Registration RequestDeadlineError becomes the 30s placeholder', async () => {
    vi.spyOn(BlockchainService.prototype, 'getV2Registration').mockRejectedValue(
      new RequestDeadlineError('deadline during v2 read'),
    );
    const sepoliaResolver = '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5';
    const body = {
      name: 'precheck-outage.eth',
      hierarchy: [
        { name: 'eth', owner: ZERO_OWNER, resolver: sepoliaResolver, level: 1 },
        { name: 'precheck-outage.eth', owner: ZERO_OWNER, resolver: sepoliaResolver, level: 2 },
      ],
    };

    await expectShortCachedPlaceholder(
      '/registry-hierarchy/precheck-outage.eth?network=sepolia',
      body,
    );
  });
});