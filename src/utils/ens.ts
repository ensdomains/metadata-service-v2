import { namehash } from "@ensdomains/ensjs/utils";
import { ens_normalize as normalize } from "@adraffy/ens-normalize";
import { keccak256, numberToHex, pad, toHex } from "viem";
import { packetToBytes, labelhash } from "viem/ens";
import { InvalidTokenIdError } from "../services/errors";

// Type declaration for Intl.Segmenter
declare namespace Intl {
  class Segmenter {
    public segment: (name: string) => string;
  }
}

// Re-export library utilities (namehash → ensjs, labelhash → viem, normalize → adraffy)
export { namehash, normalize, labelhash };

// Version enum
export enum Version {
  v1,
  v1w,
  v2,
}

// Character set types
export type CharacterSet = 'alphanumeric' | 'digit' | 'emoji' | 'letter' | 'mixed';
export const characterSet: { [key: string]: CharacterSet } = Object.freeze({
  ALPHANUMERIC: 'alphanumeric',
  DIGIT       : 'digit',
  EMOJI       : 'emoji',
  LETTER      : 'letter',
  MIXED       : 'mixed',
});

// ETH namehash constant
const ETH_NAMEHASH = '4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0';

// ETH namehash construction
export function constructEthNameHash(tokenId: string, version: Version): string {
  if (version > Version.v1) return tokenId;

  const label0x = pad(numberToHex(BigInt(tokenId)), { size: 32 }).replace('0x', '');
  const labels = [label0x, ETH_NAMEHASH];

  let node = '0000000000000000000000000000000000000000000000000000000000000000';
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelSha = labels[i];
    const combined = node + labelSha;
    node = keccak256(`0x${combined}`).replace('0x', '');
  }
  return '0x' + node;
}

// Extract label from ENS name
export function getLabel(name: string): string {
  const parts = name.split(".");
  return parts[0];
}

// Get parent domain
export function getParent(name: string): string {
  const parts = name.split(".");
  if (parts.length <= 1) {
    return "";
  }
  return parts.slice(1).join(".");
}

// Check if name is .eth second-level domain
export function isEthDomain(name: string): boolean {
  const parts = name.split(".");
  return parts.length === 2 && parts[1] === "eth";
}

/**
 * The .eth second-level label that keys a name's entry in the v2 ETHRegistry,
 * or null when the name has no such entry (non-.eth names, or the bare "eth" TLD).
 * The ETHRegistry keys .eth 2LD labels ONLY, so for `sub.foo.eth` the relevant
 * label is `foo` (the subname's v2/migration state follows its 2LD: a migrated
 * 2LD's subtree lives in its v2 subregistries). Using the FIRST label here was a
 * real bug: `sub.foo.eth` would be classified by the status of the unrelated 2LD
 * `sub.eth`.
 */
export function eth2ldLabel(name: string): string | null {
  const parts = name.split(".");
  if (parts.length < 2 || parts[parts.length - 1] !== "eth") return null;
  return parts[parts.length - 2];
}

// Check if name is subdomain
export function isSubdomain(name: string): boolean {
  const parts = name.split(".");
  return parts.length > 2;
}

// Get domain level (eth = 1, subdomain.eth = 2, etc.)
export function getDomainLevel(name: string): number {
  return name.split(".").length;
}

// Convert token ID to proper hex format. Token ids are uint256: a value at or
// above 2^256 must throw, not widen into a 65-digit hex string.
export function tokenIdToHex(tokenId: string): `0x${string}` {
  if (tokenId.startsWith("0x")) {
    if (/^0x[0-9a-fA-F]+$/.test(tokenId) && BigInt(tokenId) >= 2n ** 256n) {
      throw new InvalidTokenIdError();
    }
    return tokenId as `0x${string}`;
  }

  // Convert from decimal to hex
  const value = BigInt(tokenId);
  if (value >= 2n ** 256n) {
    throw new InvalidTokenIdError();
  }
  const hex = value.toString(16).padStart(64, "0");
  return `0x${hex}` as `0x${string}`;
}

// Canonical form of a v2 ETHRegistry tokenId: the labelhash with its low 32
// bits (the token-version counter) zeroed. Any version of a token maps to the
// same canonicalId, which is what the zigens `canonicalId` field stores.
export function canonicalTokenId(tokenId: string): `0x${string}` {
  const hex = tokenIdToHex(tokenId).toLowerCase();
  return `${hex.slice(0, -8)}00000000` as `0x${string}`;
}

// Determine if token ID represents v1 or v2 name
export function getTokenIdVersion(tokenId: string, name?: string): "v1" | "v2" {
  if (!name) {
    // Without name, we can't definitively determine version
    // Default to v2 for new service
    return "v2";
  }

  // For .eth domains, check if tokenId matches labelhash (v1) or namehash (v2)
  if (isEthDomain(name)) {
    const label = getLabel(name);
    const expectedLabelhash = labelhash(label);
    const expectedNamehash = namehash(name);

    const tokenIdHex = tokenIdToHex(tokenId);

    if (tokenIdHex === expectedLabelhash) {
      return "v1";
    } else if (tokenIdHex === expectedNamehash) {
      return "v2";
    }
  }

  // For subdomains, always v2
  if (isSubdomain(name)) {
    return "v2";
  }

  return "v2";
}

// Convert hex values to proper format
export function ensureHex(value: string | bigint): `0x${string}` {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}` as `0x${string}`;
  }

  if (value.startsWith("0x")) {
    return value as `0x${string}`;
  }

  return `0x${value}` as `0x${string}`;
}

// Address zero constant
const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

// Empty hash constant
const EMPTY_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

// Check if address is zero/empty
export function isEmptyAddress(address: string): boolean {
  return !address || address === ZERO_ADDRESS;
}

// Check if hash is zero/empty
export function isEmptyHash(hash: string): boolean {
  return !hash || hash === EMPTY_HASH;
}

// Max accepted ENS name length. Caps cache-key size (KV keys are limited to 512
// bytes; `meta:`/`svg:` prefixes + network/status leave room for ~255) and blocks
// cache-flooding via arbitrarily long names.
export const MAX_ENS_NAME_LENGTH = 255;

// Max accepted number of labels in a name. Real names are a few levels deep, so
// 32 is far above any legitimate use. Caps the per-label work of the name-taking
// routes (the registry-hierarchy blockchain tier resolves every ancestor level),
// which MAX_ENS_NAME_LENGTH alone leaves at up to 128 one-character labels.
export const MAX_NAME_LABELS = 32;

/**
 * Canonical form for cache keys, indexer queries, and invalidation matching.
 * ENS labels are case-insensitive (the namehash lowercases ASCII), so two
 * requests differing only in case MUST map to the same cache entry. NFC + lower
 * is a safe canonicalization that never throws (unlike full ENSIP-15 normalize,
 * which we still surface separately via `isNormalized`).
 */
export function canonicalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * DNS wire-format encoding of an ENS name for UniversalResolverV2.findResolver/
 * resolve (length-prefixed labels + null root, e.g. "foo.eth" → 0x03666f6f0365746800).
 * Delegates to viem's `packetToBytes`, which also handles >255-byte labels via
 * labelhash exactly as the UniversalResolver expects.
 */
export function dnsEncodeName(name: string): `0x${string}` {
  return toHex(packetToBytes(name));
}

// Validate ENS name format
export function validateEnsName(name: string): boolean {
  if (!name || name.length === 0) {
    return false;
  }

  if (name.length > MAX_ENS_NAME_LENGTH) {
    return false;
  }

  // Basic validation - contains at least one dot and ends with valid TLD
  const parts = name.split(".");
  if (parts.length < 2) {
    return false;
  }

  if (parts.length > MAX_NAME_LABELS) {
    return false;
  }

  // Check for empty labels
  for (const part of parts) {
    if (!part || part.length === 0) {
      return false;
    }
  }

  return true;
}

/**
 * Whether this service can look `name` up at all: validateEnsName's checks, and
 * a canonical form the lookups' namehash can hash. That namehash (ensjs) runs
 * each label through ENSIP-15 normalization and throws on one it rejects: a
 * disallowed character such as ':', '/', a space, a control character or '_'
 * after the start of a label, or an illegal mixture. Such a name has no node the
 * indexers or the chain can be asked about, so it is a client error (400); it
 * used to fail inside the lookup and be reported as an outage (503). Names that
 * normalize to another form (upper case, say) and encoded labelhashes (`[…]`)
 * still pass.
 */
export function isResolvableEnsName(name: string): boolean {
  if (!validateEnsName(name)) return false;
  try {
    namehash(canonicalizeName(name));
    return true;
  } catch {
    return false;
  }
}

// Character set analysis
export function getCharacterSet(name: string): CharacterSet {
  const label = getLabel(name);
  return findCharacterSet(label);
}

export function findCharacterSet(label: string): CharacterSet {
  // regex digit only
  if (/^[0-9]+$/.test(label)) return characterSet.DIGIT;
  // regex latin letters only
  if (/^[a-zA-Z]+$/.test(label)) return characterSet.LETTER;
  // regex unicode mode, alphanumeric
  // \p{L} or \p{Letter}: any kind of letter from any language.
  // \p{N} or \p{Number}: any kind of numeric character in any script.
  if (/^[\p{L}\p{N}]*$/u.test(label)) return characterSet.ALPHANUMERIC;
  // regex emoji only
  if (/^[\p{Extended_Pictographic}|\p{Emoji_Component}]+$/gu.test(label)) return characterSet.EMOJI;

  return characterSet.MIXED;
}

// Get segment length using grapheme clusters
export function getSegmentLength(name: string): number {
  const label = getLabel(name);
  let count = 0;
  for (const _ of new Intl.Segmenter().segment(label)) {
    count++;
  }
  return count;
}

// Check if name is normalized
export function isNormalized(name: string): boolean {
  return _checkNormalized(name);
}

function _checkNormalized(name: string): boolean {
  try {
    return name === normalize(name);
  } catch {
    return false;
  }
}

