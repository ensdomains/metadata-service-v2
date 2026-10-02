import { describe, expect, it } from 'vitest';
import { InvalidTokenIdError } from '../src/services/errors';
import { tokenIdToHex } from '../src/utils/ens';

// W3-NAMES-003 / N4: token ids are uint256. Decimal 2^256 must throw
// InvalidTokenIdError. On main it returns a 65-digit hex value instead.
describe('W3-NAMES-003 out-of-range token ids', () => {
  it('decimal 2^256 throws InvalidTokenIdError instead of returning a 65-digit hex value', () => {
    const tokenId = (2n ** 256n).toString();
    let returned: string | undefined;
    let thrown: unknown;
    try {
      returned = tokenIdToHex(tokenId);
    } catch (error) {
      thrown = error;
    }
    const digits = returned?.replace(/^0x/i, '').length;
    expect(thrown, `returned ${returned} (${digits}-digit hex) instead of throwing InvalidTokenIdError`).toBeInstanceOf(
      InvalidTokenIdError,
    );
  });

  it('decimal 2^256 - 1 still converts to a 32-byte hex value', () => {
    expect(tokenIdToHex((2n ** 256n - 1n).toString())).toBe(`0x${'f'.repeat(64)}`);
  });
});
