import { describe, expect, it, vi } from "vitest";
import { CacheKeys, CacheService, KV_MAX_KEY_BYTES } from "../src/services/cache";
import { canonicalizeName, isResolvableEnsName } from "../src/utils/ens";

// U+03AA U+0301 lowercases to a sequence NFC then composes to U+0390.
// One NFC+lowercase pass is not a fixed point, so a purge that canonicalizes
// and then calls CacheKeys must still hit the key the read path wrote.
const IOTA = "\u03AA\u0301.eth";
const IOTA_STABLE = "\u0390.eth";

// U+0958 is excluded from composition, so NFC expands it. Eighty of them plus
// ".eth" is still a resolvable name, and the namespaced key exceeds KV's limit.
const QA = "\u0958".repeat(80) + ".eth";

describe("CacheKeys closure and KV key limit", () => {
  it("gives a resolvable non-idempotent name one hierarchy key for read and purge", () => {
    expect(isResolvableEnsName(IOTA)).toBe(true);
    const expected = `ensnode:mainnet:hierarchy:${IOTA_STABLE}`;
    expect(CacheKeys.hierarchy(IOTA, "mainnet")).toBe(expected);
    expect(CacheKeys.hierarchy(canonicalizeName(IOTA), "mainnet")).toBe(expected);
    expect(CacheKeys.domain(IOTA, "sepolia")).toBe(`ensnode:sepolia:domain:${IOTA_STABLE}`);
    expect(CacheKeys.migrationStatus(IOTA, "mainnet")).toBe(
      `ensnode:mainnet:migration:${IOTA_STABLE}`,
    );
    expect(CacheKeys.domains([IOTA, canonicalizeName(IOTA)], "mainnet")).toBe(
      `ensnode:mainnet:batch:${IOTA_STABLE},${IOTA_STABLE}`,
    );
  });

  it("does not call KV when NFC expands a resolvable name past the key limit", async () => {
    expect(isResolvableEnsName(QA)).toBe(true);
    const key = CacheKeys.hierarchy(QA, "mainnet");
    const built = `indexer:${key}`;
    expect(new TextEncoder().encode(built).length).toBeGreaterThan(KV_MAX_KEY_BYTES);

    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const cache = new CacheService(kv as unknown as KVNamespace);

    await expect(cache.get(key)).resolves.toBeNull();
    await cache.set(key, { ok: true });
    await cache.delete(key);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();

    await cache.get("ensnode:mainnet:hierarchy:é.eth");
    expect(kv.get).toHaveBeenCalledOnce();
  });
});
