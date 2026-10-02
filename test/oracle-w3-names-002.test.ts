import { describe, expect, it } from 'vitest';
import { InvalidTokenIdError } from '../src/services/errors';
import { tokenIdToHex } from '../src/utils/ens';

// Blind oracle for W3-NAMES-002. The finding is tokenIdToHex("one") at
// src/utils/ens.ts, not the route: resolveTokenId already rejects "one"
// before it calls tokenIdToHex, so a route test would pass on this baseline.
describe('W3-NAMES-002 garbage spellings', () => {
  it('tokenIdToHex("one") throws InvalidTokenIdError, never a bare SyntaxError', () => {
    expect(() => tokenIdToHex('one')).toThrow(InvalidTokenIdError);
  });
});
