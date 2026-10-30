import { describe, it, expect, vi } from 'vitest';
import { FallbackService, DEFAULT_FALLBACK_CONFIG } from '../src/services/fallback';
import { NotFoundError } from '../src/services/errors';

// FALLBACK-S2-001. Terminal absence is definitive only when every consulted
// tier, including an actually consulted primary, cleanly missed. A disabled
// primary has v2Consulted=false and must not be treated as definitive.

const ZERO = '0x0000000000000000000000000000000000000000';

function indexer(domain: { name: string } | null) {
  return {
    getDomain: vi.fn(async () => ({ domain })),
    getMigrationStatus: vi.fn(),
    getHierarchy: vi.fn(),
  };
}

function chainCleanMiss() {
  return {
    resolveName: vi.fn(async (name: string) => ({
      name,
      resolver: { owner: ZERO, resolver: ZERO },
      migrationStatus: 'unmigrated',
    })),
  };
}

describe('FALLBACK-S2-001 — disabled primary is not a definitive miss', () => {
  it('primary disabled, v1 clean miss, chain clean miss yields NotFoundError.definitive === false', async () => {
    const v2 = indexer({ name: 'should-not-be-consulted.eth' });
    const v1 = indexer(null);
    const chain = chainCleanMiss();
    const config = {
      ...DEFAULT_FALLBACK_CONFIG,
      indexerV2: { ...DEFAULT_FALLBACK_CONFIG.indexerV2, enabled: false },
    };
    const svc = new FallbackService(config, v2 as any, {} as any, chain as any, v1 as any);

    await expect(svc.getDomainMetadata('ghost.eth')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).definitive).toBe(false);
      return true;
    });
    expect(v2.getDomain).not.toHaveBeenCalled();
  });

  it('an actually consulted primary clean miss stays definitive', async () => {
    const v2 = indexer(null);
    const v1 = indexer(null);
    const chain = chainCleanMiss();
    const svc = new FallbackService(DEFAULT_FALLBACK_CONFIG, v2 as any, {} as any, chain as any, v1 as any);

    await expect(svc.getDomainMetadata('ghost.eth')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).definitive).toBe(true);
      return true;
    });
    expect(v2.getDomain).toHaveBeenCalledTimes(1);
  });
});
