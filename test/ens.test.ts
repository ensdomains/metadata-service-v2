import { describe, it, expect } from 'vitest';
import {
  namehash,
  labelhash,
  normalize,
  getLabel,
  getParent,
  isEthDomain,
  isSubdomain,
  getDomainLevel,
  getCharacterSet,
  validateEnsName,
  canonicalizeName,
  dnsEncodeName,
  isEmptyAddress,
  isEmptyHash,
  isNormalized,
  getSegmentLength
} from '../src/utils/ens';

describe('ENS Utilities', () => {
  describe('namehash', () => {
    it('should generate correct namehash for empty string', () => {
      expect(namehash('')).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('should generate correct namehash for eth TLD', () => {
      const ethHash = namehash('eth');
      expect(ethHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(ethHash).not.toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('should generate correct namehash for second-level domain', () => {
      const testHash = namehash('test.eth');
      expect(testHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(testHash).not.toBe(namehash('eth'));
    });

    it('should generate correct namehash for subdomain', () => {
      const subdomainHash = namehash('sub.test.eth');
      expect(subdomainHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(subdomainHash).not.toBe(namehash('test.eth'));
    });
  });

  describe('labelhash', () => {
    it('should generate correct labelhash', () => {
      const hash = labelhash('test');
      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should generate different hashes for different labels', () => {
      const hash1 = labelhash('test');
      const hash2 = labelhash('example');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('name parsing', () => {
    it('should extract correct label', () => {
      expect(getLabel('test.eth')).toBe('test');
      expect(getLabel('sub.test.eth')).toBe('sub');
    });

    it('should extract correct parent', () => {
      expect(getParent('test.eth')).toBe('eth');
      expect(getParent('sub.test.eth')).toBe('test.eth');
      expect(getParent('eth')).toBe('');
    });

    it('should identify .eth domains correctly', () => {
      expect(isEthDomain('test.eth')).toBe(true);
      expect(isEthDomain('sub.test.eth')).toBe(false);
      expect(isEthDomain('test.com')).toBe(false);
    });

    it('should identify subdomains correctly', () => {
      expect(isSubdomain('test.eth')).toBe(false);
      expect(isSubdomain('sub.test.eth')).toBe(true);
      expect(isSubdomain('deep.sub.test.eth')).toBe(true);
    });

    it('should calculate domain level correctly', () => {
      expect(getDomainLevel('eth')).toBe(1);
      expect(getDomainLevel('test.eth')).toBe(2);
      expect(getDomainLevel('sub.test.eth')).toBe(3);
    });
  });

  describe('character set detection', () => {
    it('should identify letter names', () => {
      expect(getCharacterSet('test.eth')).toBe('letter');
      expect(getCharacterSet('hello.eth')).toBe('letter');
    });

    it('should identify digit names', () => {
      expect(getCharacterSet('123.eth')).toBe('digit');
      expect(getCharacterSet('999.eth')).toBe('digit');
    });

    it('should identify alphanumeric names', () => {
      expect(getCharacterSet('test123.eth')).toBe('alphanumeric');
      expect(getCharacterSet('123test.eth')).toBe('alphanumeric');
    });

    it('should identify emoji names', () => {
      expect(getCharacterSet('😀.eth')).toBe('emoji');
      expect(getCharacterSet('🚀.eth')).toBe('emoji');
    });

    it('should identify mixed names', () => {
      expect(getCharacterSet('test@123.eth')).toBe('mixed');
      expect(getCharacterSet('hello-world.eth')).toBe('mixed');
      expect(getCharacterSet('🥛shake.eth')).toBe('mixed'); // emoji + letters
    });

    it('should identify international letters as alphanumeric', () => {
      expect(getCharacterSet('güneş.eth')).toBe('alphanumeric'); // Turkish
      expect(getCharacterSet('солнце.eth')).toBe('alphanumeric'); // Russian
      expect(getCharacterSet('שמש.eth')).toBe('alphanumeric'); // Hebrew
      expect(getCharacterSet('太陽.eth')).toBe('alphanumeric'); // Chinese
    });

    it('should handle complex emoji combinations', () => {
      expect(getCharacterSet('👨🏻‍🚀.eth')).toBe('emoji'); // Complex emoji
    });
  });

  describe('validation', () => {
    it('should validate correct ENS names', () => {
      expect(validateEnsName('test.eth')).toBe(true);
      expect(validateEnsName('sub.test.eth')).toBe(true);
      expect(validateEnsName('example.com')).toBe(true);
    });

    it('should reject invalid ENS names', () => {
      expect(validateEnsName('')).toBe(false);
      expect(validateEnsName('test')).toBe(false);
      expect(validateEnsName('.eth')).toBe(false);
      expect(validateEnsName('test.')).toBe(false);
    });

    it('should reject names exceeding the max length cap', () => {
      const tooLong = 'a'.repeat(256) + '.eth';
      expect(validateEnsName(tooLong)).toBe(false);
      expect(validateEnsName('a'.repeat(60) + '.eth')).toBe(true);
    });

    it('canonicalizeName lowercases + NFC-normalizes for case-insensitive keys', () => {
      expect(canonicalizeName('Vitalik.ETH')).toBe('vitalik.eth');
      expect(canonicalizeName('FOO.eth')).toBe(canonicalizeName('foo.eth'));
    });

    it('dnsEncodeName produces DNS wire format (UniversalResolver findResolver input)', () => {
      expect(dnsEncodeName('foo.eth')).toBe('0x03666f6f0365746800');
      expect(dnsEncodeName('')).toBe('0x00'); // root
    });

    it('should identify empty addresses', () => {
      expect(isEmptyAddress('0x0000000000000000000000000000000000000000')).toBe(true);
      expect(isEmptyAddress('')).toBe(true);
      expect(isEmptyAddress('0x1234567890123456789012345678901234567890')).toBe(false);
    });

    it('should identify empty hashes', () => {
      expect(isEmptyHash('0x0000000000000000000000000000000000000000000000000000000000000000')).toBe(true);
      expect(isEmptyHash('')).toBe(true);
      expect(isEmptyHash('0x1234567890123456789012345678901234567890123456789012345678901234')).toBe(false);
    });
  });

  describe('normalization', () => {
    it('should normalize valid ENS names', () => {
      expect(normalize('test.eth')).toBe('test.eth');
      expect(normalize('hello.eth')).toBe('hello.eth');
    });

    it('should normalize mixed case names to lowercase', () => {
      expect(normalize('Test.eth')).toBe('test.eth');
      expect(normalize('HELLO.eth')).toBe('hello.eth');
    });

    it('should check if name is normalized', () => {
      expect(isNormalized('test.eth')).toBe(true);
      expect(isNormalized('Test.eth')).toBe(false);
      expect(isNormalized('HELLO.eth')).toBe(false);
    });

    it('should get proper segment length with unicode', () => {
      expect(getSegmentLength('test.eth')).toBe(4);
      expect(getSegmentLength('hello.eth')).toBe(5);
      expect(getSegmentLength('😀.eth')).toBe(1);
    });

    it('should handle complex grapheme clusters properly', () => {
      // Complex emoji with modifiers should count as 1 segment
      expect(getSegmentLength('👨🏻‍🚀.eth')).toBe(1);
      // Combined characters should be counted properly
      expect(getSegmentLength('é.eth')).toBe(1); // é as single character
    });
  });
});