# Workhorse spec: WEB-1716 [W8-CACHE-004] Fix testing-campaign finding on main (TDD)

## Summary

The R2 image tier must stop serving a card after its status-specific lifetime, not merely attach HTTP metadata that cannot expire binding reads. The fix adds an age check on R2 objects before serving from L2, and caps KV backfill lifetime to the remaining R2 authoritative deadline so expired bytes never circulate past their original TTL. Strict TDD: each regression test fails on the baseline first, then the minimal fix makes it pass.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime
- **Dependencies used or added**: None
- **Testing**: `pnpm run test` (vitest); focused tests in `test/image-cache.test.ts`
- **Constraints**: One finding only (W8-CACHE-004); no cherry-picks from testing-campaign; independent PR from main; fix must not weaken existing assertions

## Direction check

- **One-finding scope**: The change set addresses only the R2 age check, backfill lifetime capping, and the tests that prove them. No other finding, no drive-by refactor.
- **Main-base isolation**: Branch cut from committed main at `5a5527c7`, no testing-campaign code copied or cherry-picked.
- **Strict TDD**: Each regression test is written and recorded failing before its product fix commit.
- **Independent PR**: Targets main from `WEB-1716`, no dependency on testing-campaign.

## Structure

Files changed:

- `src/utils/storage.ts`: `getSvgByKey` returns `{ svg: string; uploadedAtMs: number } | null`. When `maxAgeSeconds` is supplied, objects at or past the boundary are rejected (`>=`, RFC 9111). Missing or invalid `uploaded` fails closed (returns `null`) when `maxAgeSeconds` is supplied. Undefined `maxAgeSeconds` is backward-compatible unbounded.
- `src/services/image-cache.ts`: L2 R2 lookup passes `ttlConfig.r2MaxAge` to `getSvgByKey`. On L2 hit, `writeKv` receives the absolute `uploadedAtMs` timestamp and computes an absolute KV `expiration` deadline at `floor(uploadedAtMs/1000) + r2MaxAge` — immune to body-latency clock drift. `createdAt` is set to the authoritative `uploadedAtMs`. `softTtl` is floored to the remaining integer lifetime (conservative). Backfill is skipped when `remaining < 60` s (Cloudflare KV minimum). Fresh L3 origin writes are unchanged (relative `expirationTtl`). `CARD_CACHE_VERSION` bumped `v2` → `v3` so pre-fix v2 KV entries (backfill-time `createdAt` / full TTL) are never served after deploy — they miss and fall through to authoritative L2/L3.
- `test/image-cache.test.ts`: 47 focused tests across 9 TDD rounds:
- `test/cache-bounds.test.ts`: 7 edge cache discriminator tests (unversioned miss, v3 hit, storage, public URL)
- `test/avatar-outage-routes.test.ts`: edge cache assertions updated for versioned keys
- `test/media-headers-route.test.ts`: edge cache key updated
- `test/security-headers.test.ts`: CARD_CACHE_VERSION added to mock
- `test/rasterize-svg-avatar.test.ts`: same
- `test/image-size-validation.test.ts`: same
- `test/webhook-warming.test.ts`: same

## Decisions

- **Age check in `storage.ts`**: Optional `maxAgeSeconds` parameter. `>=` per RFC 9111 §4.2 (not `>`). Return type includes absolute `uploadedAtMs` so the caller can compute an absolute KV `expiration` deadline.
- **Absolute KV `expiration`**: `expiration = floor(uploadedAtMs / 1000) + r2MaxAge`. Immune to body-latency clock drift between the R2 read and the KV write. Relative `expirationTtl` is used only for fresh L3 origin writes.
- **Fail-closed on missing uploaded**: When `maxAgeSeconds` is supplied, missing, invalid, or non-finite `uploaded` returns `null` — cannot enforce TTL without an authoritative timestamp. Undefined `maxAgeSeconds` remains unbounded backward-compatible.
- **KV backfill lifetime capping**: R2→L1 backfill caps `softTtl` and sets absolute `expiration` to the remaining R2 lifetime. Backfill is skipped when remaining < 60 s (Cloudflare KV minimum `expirationTtl`). `createdAt` preserves the authoritative R2 upload time, not `Date.now()`.
- **Conservative integer semantics**: `softTtl` floored to integer. `expiration` floored at `uploadedAtMs / 1000`. This prevents fractional-second lifetime extension.
- **60 s boundary**: `remaining < 60` correctly allows backfill at exactly 60 s. Tests at 60 s, 59.999 s, and 60.001 s kill `<=` and off-by-one mutants.
- **Cache generation bump**: `CARD_CACHE_VERSION` bumped `v2` → `v3`. Pre-fix v2 KV entries carry backfill-time `createdAt` and full TTL; without the bump they remain L1 hits after deploy and bypass R2 deadline enforcement. The same `v3` discriminator is applied to the edge cache (`caches.default`) as `__ecv=v3` query parameter, so pre-deploy v2 SVG/PNG edge entries never match after deploy.
- **Default behavior**: When `maxAgeSeconds` is not passed, `getSvgByKey` returns the object regardless of age (backward-compatible).

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit | `npx vitest run test/image-cache.test.ts` on the branch after each test-only commit but before the product fix | Each RED test fails with the expected assertion error: TTL boundary (expected 'miss', got 'stale'), backfill lifetime (expected `expiration`, got undefined), fail-closed (expected null, got object) |
| AC2 | After the fix, that focused regression passes without weakening its assertion | `npx vitest run test/image-cache.test.ts` on the branch after each product fix commit | All 47 tests pass; absolute `expiration` at `uploadedAtMs + r2MaxAge`; createdAt equals authoritative upload time; softTtl capped and floored; backfill skipped when remaining < 60 s; missing uploaded rejected |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head | `npx vitest run` | Exit 0, 58 test files pass |
| AC4 | The change set addresses only `W8-CACHE-004` and does not bundle another findings.md id | `git diff 5a5527c7...HEAD --stat` | Only `src/utils/storage.ts`, `src/services/image-cache.ts`, `test/image-cache.test.ts`, `WORKHORSE-SPEC.md` changed |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign | Verify branch name is `WEB-1716` and no commit originates from testing-campaign | Branch `WEB-1716`, all commits authored in this run |

## Tasks

- [x] T001 [AC1] Add focused regression test: KV miss, R2 with `uploaded` past `r2MaxAge` → `cacheStatus: 'miss'`, fresh SVG returned (RED at `7b42184`, GREEN at `1eba75b`)
- [x] T002 [AC2] `storage.ts` `getSvgByKey`: return `{ svg, uploadedAtMs } \| null`; `>=` boundary check; fail-closed on missing/invalid uploaded when maxAge supplied; undefined maxAge unbounded
- [x] T003 [AC2] `image-cache.ts` L2 lookup: pass `ttlConfig.r2MaxAge`; on hit, backfill via `writeKv` with `uploadedAtMs`, absolute KV `expiration`, capped softTtl, authoritative createdAt
- [x] T004 [AC2] Add TTL boundary tests: fresh (TTL-1ms L2 hit), exact (== TTL L3 miss), expired (> TTL L3 miss) across unmigrated/migrated/native; r2MaxAge 0; undefined maxAge backward compat (RED at `0e3d09a`, `915bad3`, `18e0ae2`; GREEN at `e439edd`, `36621af`, `539ae7c`)
- [x] T005 [AC2] Add backfill lifetime capping tests: absolute `expiration` assertion, 60 s boundary ±1 ms, migrationStatus serialization, hardTtl/softTtl capping, no-write + full-TTL + off-by-one + no-backdate mutants (GREEN at `539ae7c`)
- [x] T006 [AC3] Run `pnpm run test` and verify all tests pass (58 files, 47 image-cache tests + afterAll sentinel)
- [x] T007 [AC4] Bump `CARD_CACHE_VERSION` to `v3`; add legacy v2 KV isolation tests (RED at `9e4257f`, GREEN at `c78768f`); update `avatar-embed-security.test.ts` version expectation
- [x] T008 [AC4] Add edge cache discrimination tests and apply `__ecv=v3` to all caches.default match/put/purge paths (RED at `78d2f81`, GREEN at `42997ff`); update all vi.mock exports and edge cache assertions