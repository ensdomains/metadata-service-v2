import { describe, expect, it } from 'vitest';
import { tokenIdToHex } from '../src/utils/ens';

const ZERO = `0x${'0'.repeat(64)}`;

describe('W3-NAMES-001 tokenIdToHex spellings', () => {
  it('maps decimal 0 and 0x0 to 0x plus 64 zeroes', () => {
    expect(tokenIdToHex('0')).toBe(ZERO);
    expect(tokenIdToHex('0x0')).toBe(ZERO);
  });

  it('maps mixed-case 0x spellings to the same padded lowercase form as decimal', () => {
    const padded = `0x${'a'.padStart(64, '0')}`;
    expect(tokenIdToHex('10')).toBe(padded);
    expect(tokenIdToHex('0xA')).toBe(padded);
    expect(tokenIdToHex('0xa')).toBe(padded);
  });
});
