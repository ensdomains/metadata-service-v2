import { ens_normalize as normalize } from '@adraffy/ens-normalize';
import { describe, expect, it } from 'vitest';
import { CacheKeys } from '../../src/services/cache';
import { canonicalizeName } from '../../src/utils/ens';

// SEC-NAME-001: accepted spellings that ENSIP-15 identifies as the same name
// must share every name-keyed cache entry. Expected values are checked-in
// literals and cross-checked with the normative normalizer, not produced by the
// service helper under test.
const EQUIVALENT_NAMES = [
  { raw: 'ａｌｉｃｅ.eth', canonical: 'alice.eth' },
  { raw: 'al\u200Bice.eth', canonical: 'alice.eth' },
  { raw: '❤️.eth', canonical: '❤.eth' },
] as const;

describe('SEC-NAME-001: ENSIP-15-equivalent names have one cache identity', () => {
  it.each(EQUIVALENT_NAMES)('$raw uses the canonical key $canonical', ({ raw, canonical }) => {
    expect(normalize(raw)).toBe(canonical);
    expect(normalize(canonical)).toBe(canonical);
    expect(canonicalizeName(raw)).toBe(canonical);
    expect(CacheKeys.hierarchy(raw, 'mainnet')).toBe(
      `ensnode:mainnet:hierarchy:${canonical}`,
    );
  });

  it('positive control: distinct valid lookalikes remain separate', () => {
    expect(normalize('o.eth')).toBe('o.eth');
    expect(normalize('0.eth')).toBe('0.eth');
    expect(CacheKeys.hierarchy('o.eth', 'mainnet')).not.toBe(
      CacheKeys.hierarchy('0.eth', 'mainnet'),
    );
  });
});
