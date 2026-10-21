import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataService, DomainExpiredError } from '../src/services/metadata';
import { MIGRATION_STATUS } from '../src/types';

// Wiring tests for the signal→status derivation that feeds the (already
// unit-tested) migration reducer: statusFromSource / classifyName /
// checkExpiry, exercised through the public MetadataService surface with the
// fallback + blockchain layers stubbed. Sepolia-focused: mainnet has no v2
// deployment yet (placeholder contracts).

const OWNER = '0x7bc153b2a4c8a2f3428bd0da77a901b81c6dd809';
const ZERO = '0x0000000000000000000000000000000000000000';

function makeSepoliaService(): MetadataService {
  return new MetadataService(
    {
      indexerV2Endpoint: 'https://sepolia.api.bigname.test',
      network: 'sepolia',
      fallbackToBlockchain: true,
      internalCacheEnabled: false,
      d1Enabled: false,
    },
    { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as unknown as KVNamespace,
    { MAINNET_RPC_URL: 'https://mainnet.test.rpc', SEPOLIA_RPC_URL: 'https://sepolia.test.rpc' },
  );
}

type Priv = {
  fallback: { getMigrationStatus: ReturnType<typeof vi.fn>; getDomainMetadata: ReturnType<typeof vi.fn> };
  blockchain: Record<string, ReturnType<typeof vi.fn>>;
};

function stub(svc: MetadataService, overrides: Partial<Priv>): Priv {
  const p = svc as unknown as Priv;
  if (overrides.fallback) p.fallback = overrides.fallback as Priv['fallback'];
  if (overrides.blockchain) p.blockchain = overrides.blockchain as Priv['blockchain'];
  return p;
}

function fallbackReturning(result: {
  source: 'indexerV2' | 'blockchain';
  v2Consulted: boolean;
  data: Record<string, unknown>;
}) {
  const value = { ...result, usedFallback: result.source !== 'indexerV2', fallthroughs: 0 };
  return {
    getMigrationStatus: vi.fn().mockResolvedValue(value),
    getDomainMetadata: vi.fn().mockResolvedValue(value),
  };
}

describe('statusFromSource wiring (via getMigrationStatus)', () => {
  let svc: MetadataService;
  beforeEach(() => { svc = makeSepoliaService(); });

  it('v2-dialect record with isMigrated=false and a real owner → native', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'fox.eth', isMigrated: false, owner: { id: OWNER }, protocol: 'v2' },
      }),
    });
    const res = await svc.getMigrationStatus('fox.eth');
    expect(res.status).toBe(MIGRATION_STATUS.NATIVE);
  });

  it('v2-dialect record with isMigrated=true → migrated', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'moved.eth', isMigrated: true, owner: { id: OWNER }, protocol: 'v2' },
      }),
    });
    expect((await svc.getMigrationStatus('moved.eth')).status).toBe(MIGRATION_STATUS.MIGRATED);
  });

  it('RESERVED pre-seed (owner 0x0) → unmigrated, never native', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'vitalik.eth', isMigrated: false, owner: { id: ZERO }, protocol: 'v2' },
      }),
    });
    expect((await svc.getMigrationStatus('vitalik.eth')).status).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('protocol:"v1" row from the v2 indexer → unmigrated (presence ≠ on v2)', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'legacy.eth', isMigrated: false, owner: { id: OWNER }, protocol: 'v1' },
      }),
    });
    expect((await svc.getMigrationStatus('legacy.eth')).status).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('v2 row without a migration timestamp → migrated, not native (bigname does not prove native yet)', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'fox.eth', owner: { id: OWNER }, protocol: 'v2' },
      }),
    });
    expect((await svc.getMigrationStatus('fox.eth')).status).toBe(MIGRATION_STATUS.MIGRATED);
  });

  it('blockchain record without its precomputed status → corroborates on-chain', async () => {
    const isUnmigratedName = vi.fn().mockResolvedValue(false);
    stub(svc, {
      fallback: fallbackReturning({
        source: 'blockchain', v2Consulted: false,
        data: { name: 'moved.eth', owner: { id: OWNER } },
      }),
      blockchain: { isUnmigratedName },
    });
    expect((await svc.getMigrationStatus('moved.eth')).status).toBe(MIGRATION_STATUS.MIGRATED);
    expect(isUnmigratedName).toHaveBeenCalledWith('sepolia', 'moved.eth');
  });

  it('on-chain corroboration unreadable → degrades to unmigrated (logged, not thrown)', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'blockchain', v2Consulted: false,
        data: { name: 'moved.eth', owner: { id: OWNER } },
      }),
      blockchain: { isUnmigratedName: vi.fn().mockRejectedValue(new Error('all RPCs failed')) },
    });
    expect((await svc.getMigrationStatus('moved.eth')).status).toBe(MIGRATION_STATUS.UNMIGRATED);
  });

  it('blockchain-sourced record carries its own on-chain classification', async () => {
    const isUnmigratedName = vi.fn();
    stub(svc, {
      fallback: fallbackReturning({
        source: 'blockchain', v2Consulted: false,
        data: { name: 'fox.eth', owner: { id: OWNER }, chainMigrationStatus: 'migrated' },
      }),
      blockchain: { isUnmigratedName },
    });
    expect((await svc.getMigrationStatus('fox.eth')).status).toBe(MIGRATION_STATUS.MIGRATED);
    expect(isUnmigratedName).not.toHaveBeenCalled(); // status travels with the record
  });
});

describe('checkExpiry — v2-over-v1 precedence (the fox.eth scenario)', () => {
  const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const PAST = BigInt(Math.floor(Date.now() / 1000) - 24 * 3600);
  let svc: MetadataService;
  beforeEach(() => { svc = makeSepoliaService(); });

  it('live on v2 (REGISTERED, future expiry) → no 410 even though the v1 registration lapsed', async () => {
    const getExpiry = vi.fn().mockResolvedValue(PAST); // lapsed v1 — must be ignored
    stub(svc, {
      blockchain: {
        isV2Configured: vi.fn().mockReturnValue(true),
        getV2Registration: vi.fn().mockResolvedValue({ status: 2, expiry: FUTURE, owner: OWNER }),
        getExpiry,
      },
    });
    await expect(svc.checkExpiry('fox.eth')).resolves.toBeUndefined();
    expect(getExpiry).not.toHaveBeenCalled();
  });

  it('REGISTERED on v2 but v2 expiry passed → 410', async () => {
    stub(svc, {
      blockchain: {
        isV2Configured: vi.fn().mockReturnValue(true),
        getV2Registration: vi.fn().mockResolvedValue({ status: 2, expiry: PAST, owner: OWNER }),
        getExpiry: vi.fn(),
      },
    });
    await expect(svc.checkExpiry('fox.eth')).rejects.toBeInstanceOf(DomainExpiredError);
  });

  it('v2 registry UNREADABLE → fails open (no 410 off the lapsed v1 expiry)', async () => {
    // 410 is cacheable and destructive; "v2 unknown + v1 lapsed" must serve.
    const getExpiry = vi.fn().mockResolvedValue(PAST);
    stub(svc, {
      blockchain: {
        isV2Configured: vi.fn().mockReturnValue(true),
        getV2Registration: vi.fn().mockRejectedValue(new Error('all RPCs failed')),
        getExpiry,
      },
    });
    await expect(svc.checkExpiry('fox.eth')).resolves.toBeUndefined();
    expect(getExpiry).not.toHaveBeenCalled();
  });

  it('not on v2 (AVAILABLE) + lapsed v1 registration → 410 (v1 authoritative)', async () => {
    stub(svc, {
      blockchain: {
        isV2Configured: vi.fn().mockReturnValue(true),
        getV2Registration: vi.fn().mockResolvedValue({ status: 0, expiry: 0n, owner: ZERO }),
        getExpiry: vi.fn().mockResolvedValue(PAST),
      },
    });
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
  });

  it('v2 not configured (mainnet-style) → v1 registrar is authoritative', async () => {
    const getV2Registration = vi.fn();
    stub(svc, {
      blockchain: {
        isV2Configured: vi.fn().mockReturnValue(false),
        getV2Registration,
        getExpiry: vi.fn().mockResolvedValue(PAST),
      },
    });
    await expect(svc.checkExpiry('gone.eth')).rejects.toBeInstanceOf(DomainExpiredError);
    expect(getV2Registration).not.toHaveBeenCalled();
  });

  it('ignores subnames and non-.eth names (2LD-only gate)', async () => {
    const isV2Configured = vi.fn();
    stub(svc, { blockchain: { isV2Configured } });
    await expect(svc.checkExpiry('sub.foo.eth')).resolves.toBeUndefined();
    await expect(svc.checkExpiry('example.com')).resolves.toBeUndefined();
    expect(isV2Configured).not.toHaveBeenCalled();
  });
});

describe('metadata output: version + registryType (v1 parity)', () => {
  let svc: MetadataService;
  beforeEach(() => { svc = makeSepoliaService(); });

  it('native v2 name → version 2, self-URLs under the requested registryType', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'fox.eth', isMigrated: false, owner: { id: OWNER }, protocol: 'v2' },
      }),
    });
    const meta = await svc.getMetadata('sepolia', 'registry', 'fox.eth', 'https://meta.test');
    expect(meta.version).toBe(2);
    expect(meta.image).toBe('https://meta.test/sepolia/registry/fox.eth/image');
    const status = meta.attributes.find(a => a.trait_type === 'Migration Status');
    expect(status?.value).toBe(MIGRATION_STATUS.NATIVE);
  });

  it('unmigrated name via /namewrapper/ → version 1 (v1w), namewrapper self-URLs', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'wrapped.eth', owner: { id: OWNER }, protocol: 'v1' },
      }),
    });
    const meta = await svc.getMetadata('sepolia', 'namewrapper', 'wrapped.eth', 'https://meta.test');
    expect(meta.version).toBe(1);
    expect(meta.image).toBe('https://meta.test/sepolia/namewrapper/wrapped.eth/image');
    expect(meta.image_url).toBe(meta.image);
  });

  it('unmigrated name via /registry/ → version 0 (v1 parity default)', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'indexerV2', v2Consulted: true,
        data: { name: 'plain.eth', owner: { id: OWNER }, protocol: 'v1' },
      }),
    });
    const meta = await svc.getMetadata('sepolia', 'registry', 'plain.eth', 'https://meta.test');
    expect(meta.version).toBe(0);
  });

  it('blockchain-tier record renders the Migration Status attribute (no silent shape change)', async () => {
    stub(svc, {
      fallback: fallbackReturning({
        source: 'blockchain', v2Consulted: false,
        data: { name: 'fox.eth', owner: { id: OWNER }, chainMigrationStatus: 'migrated' },
      }),
    });
    const meta = await svc.getMetadata('sepolia', 'registry', 'fox.eth', 'https://meta.test');
    const status = meta.attributes.find(a => a.trait_type === 'Migration Status');
    expect(status?.value).toBe(MIGRATION_STATUS.MIGRATED);
    expect(meta.version).toBe(2); // migrated → lives on v2
  });
});
