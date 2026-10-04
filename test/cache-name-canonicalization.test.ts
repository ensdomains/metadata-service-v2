import { describe, expect, it } from "vitest";
import { CacheKeys } from "../src/services/cache";

// Name-keyed cache keys must use NFC + lowercase so equivalent spellings share
// one entry. The webhook purge already canonicalizes, then deletes CacheKeys;
// a distinct NFD key written by the read path cannot be removed by that purge.

const NFC = "É.eth";
const NFD = "E\u0301.ETH";
const CANONICAL = "é.eth";

describe("CacheKeys name-keyed builders canonicalize NFC + lowercase", () => {
  it("hierarchy keys for NFC and NFD spellings are ensnode:mainnet:hierarchy:é.eth", () => {
    const expected = `ensnode:mainnet:hierarchy:${CANONICAL}`;
    expect(expected).toBe("ensnode:mainnet:hierarchy:é.eth");
    expect(CacheKeys.hierarchy(NFC, "mainnet")).toBe(expected);
    expect(CacheKeys.hierarchy(NFD, "mainnet")).toBe(expected);
  });

  it("domain keys for NFC and NFD spellings share the canonical identity", () => {
    const expected = `ensnode:mainnet:domain:${CANONICAL}`;
    expect(CacheKeys.domain(NFC, "mainnet")).toBe(expected);
    expect(CacheKeys.domain(NFD, "mainnet")).toBe(expected);
  });

  it("migrationStatus keys for NFC and NFD spellings share the canonical identity", () => {
    const expected = `ensnode:mainnet:migration:${CANONICAL}`;
    expect(CacheKeys.migrationStatus(NFC, "mainnet")).toBe(expected);
    expect(CacheKeys.migrationStatus(NFD, "mainnet")).toBe(expected);
  });

  it("domains keys canonicalize each name then sort then join, without dedup", () => {
    expect(CacheKeys.domains([NFC], "mainnet")).toBe(`ensnode:mainnet:batch:${CANONICAL}`);
    expect(CacheKeys.domains([NFD], "mainnet")).toBe(`ensnode:mainnet:batch:${CANONICAL}`);
    expect(CacheKeys.domains([NFC, NFD], "mainnet")).toBe(
      `ensnode:mainnet:batch:${CANONICAL},${CANONICAL}`,
    );
  });
});
