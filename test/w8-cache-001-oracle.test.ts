import { describe, expect, it } from "vitest";
import { CacheKeys } from "../src/services/cache";

// Acceptance test for W8-CACHE-001. Equivalent spellings must share
// name-keyed cache identity, so a canonicalizing purge hits the entry
// the read path wrote. The NFD input is E + combining acute, not a
// precomposed character.

const NFC = "É.eth";
const NFD = "E\u0301.ETH";
const CANONICAL = "é.eth";

describe("W8-CACHE-001 name-keyed cache identity", () => {
  it("maps both hierarchy spellings to ensnode:mainnet:hierarchy:é.eth", () => {
    const expected = `ensnode:mainnet:hierarchy:${CANONICAL}`;
    expect(CacheKeys.hierarchy(NFC, "mainnet")).toBe(expected);
    expect(CacheKeys.hierarchy(NFD, "mainnet")).toBe(expected);
  });

  it("maps domain and migrationStatus spellings to the same canonical key", () => {
    expect(CacheKeys.domain(NFC, "mainnet")).toBe(`ensnode:mainnet:domain:${CANONICAL}`);
    expect(CacheKeys.domain(NFD, "mainnet")).toBe(`ensnode:mainnet:domain:${CANONICAL}`);
    expect(CacheKeys.migrationStatus(NFC, "mainnet")).toBe(
      `ensnode:mainnet:migration:${CANONICAL}`,
    );
    expect(CacheKeys.migrationStatus(NFD, "mainnet")).toBe(
      `ensnode:mainnet:migration:${CANONICAL}`,
    );
  });

  it("gives equivalent batch spellings one canonical batch key", () => {
    expect(CacheKeys.domains([NFC], "mainnet")).toBe(`ensnode:mainnet:batch:${CANONICAL}`);
    expect(CacheKeys.domains([NFD], "mainnet")).toBe(`ensnode:mainnet:batch:${CANONICAL}`);
    expect(CacheKeys.domains([NFD, NFC], "mainnet")).toBe(
      `ensnode:mainnet:batch:${CANONICAL},${CANONICAL}`,
    );
  });
});
