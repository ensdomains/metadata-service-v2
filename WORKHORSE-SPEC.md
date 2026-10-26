# Workhorse spec: WEB-1675 [W3-ROUTES-009] Fix testing-campaign finding on main (TDD)

## Summary

When the registry-hierarchy route's pre-service expiry gate (`checkExpiry`) throws `NotFoundError({ definitive: false })`, the route currently returns a 404 error JSON with no `Cache-Control` and no edge write. It must instead return a 200 placeholder hierarchy with degraded 30-second cache headers, calling `edgeCachePut` and never consulting the hierarchy service. The fix is isolated to the catch block of the `/registry-hierarchy/:name` route handler in `src/index.ts`.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers (Hono)
- **Dependencies used or added**: None new. Uses existing `MetadataService`, `CachePresets`, `edgeCachePut`, `generateBasicHierarchy` (private method on `MetadataService`; the route may need access to a new public wrapper or to construct the placeholder directly).
- **Testing**: `pnpm test` runs vitest. A focused regression test goes in `test/` (e.g. a new file or in an existing hierarchy test file). The test mocks `MetadataService.checkExpiry` to throw `NotFoundError({ definitive: false })` and asserts the route returns 200 with the correct placeholder shape, `Cache-Control: public, max-age=30`, and no hierarchy-service call.
- **Constraints**: TDD — write a failing regression test first, record it, then fix. Change set addresses only W3-ROUTES-009. No cherry-picks from testing-campaign.

## Direction check

1. **TDD on main baseline**: The spec describes writing the regression test first on the ticket branch cut from main, running it to confirm failure (recording the result), then implementing the fix. ✓
2. **Minimal fix, one finding only**: The change touches only the `/registry-hierarchy/:name` catch block and adds a focused test. No other finding is bundled. ✓
3. **No cherry-picks from testing-campaign**: The regression and fix are rewritten against main, not copied from the audit branch. ✓
4. **The gate (`pnpm run test`) must pass at the ticket branch head.** ✓

## Structure

- `src/index.ts` — the catch block of the `/registry-hierarchy/:name` route handler (around line 729): add handling for `NotFoundError` with `definitive: false` BEFORE the existing fallthrough to `httpError`.
- `test/` — a new or existing test file with the focused regression test. The natural location is a test file alongside the hierarchy route tests (e.g. `test/registry-hierarchy-precheck.test.ts`).

## Decisions

1. **Placeholder construction**: The route will construct the placeholder hierarchy directly rather than exposing `generateBasicHierarchy` from `MetadataService`. The placeholder is a simple two-level hierarchy: `eth` (level 1, zero owner) and the requested name (level 2, zero owner), both with the default resolver address. This keeps the change surface minimal — no `MetadataService` API changes are needed.
2. **Where to insert the fix in the catch block**: Before the existing `if (!(error instanceof DomainExpiredError) && !(error instanceof NotFoundError))` check (which sets error cache headers for upstream errors), add a new check: `if (error instanceof NotFoundError && !error.definitive)`. This catches the non-definitive NotFoundError case and returns the degraded placeholder. The definitive NotFoundError case (W3-ROUTES-008) is a separate finding and out of scope — it continues to fall through to the existing `httpError` call (returning 404), as it does on main today.
3. **Cache headers**: Use `CachePresets.error()` which provides `Cache-Control: public, max-age=30`. This is the same degraded TTL used for other error/outage responses and matches the finding's expected behavior.
4. **Edge cache**: Call `edgeCachePut(c, res)` using the default `EDGE_CACHE_MAX_AGE_SECS` (300s) — wait, no. The finding says "captured-edge Cache-Control: public, max-age=30". But `edgeCachePut` caps the per-colo edge entry at `EDGE_CACHE_MAX_AGE_SECS` (300s) by default. The finding specifies the edge also gets 30 seconds. We should pass 30 as the `maxAgeSecs` argument to `edgeCachePut`.
5. **No `_provenance` field**: The placeholder response must not include a public `_provenance` field. `generateBasicHierarchy` does not add one, and our inline placeholder construction won't either.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm test` run against the test-only commit (before the product fix). The test mocks `MetadataService.checkExpiry()` to throw `NotFoundError({ definitive: false })` and makes a `GET /registry-hierarchy/precheck-non-definitive.eth?network=mainnet` request. | Test fails: the route returns 404 instead of 200. The failure output is captured and recorded in the run log. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm test` run against the fix commit. Same test as AC1. | Test passes. Assertions: 200 status, body has `name` and `hierarchy` with two levels (eth + requested name) both with zero owner, response headers include `Cache-Control: public, max-age=30`, `edgeCachePut` was called, `getRegistryHierarchy` was NOT called. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` | All tests pass, exit 0. |
| AC4 | The change set addresses only `W3-ROUTES-009` and does not bundle another findings.md id. | `git diff BASE...HEAD --stat` | Only the route handler catch block in `src/index.ts` and the new regression test file are changed. No other finding's code path is altered. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git log BASE...HEAD --oneline` | All commits are authored by workhorses, not cherry-picked from testing-campaign. Branch is `WEB-1675`. |

## Tasks

- [ ] T001 [P] [AC1] Write a focused regression test in `test/registry-hierarchy-precheck.test.ts` that mocks `MetadataService.checkExpiry()` to throw `NotFoundError({ definitive: false })`, makes a `GET /registry-hierarchy/precheck-non-definitive.eth?network=mainnet` request, and asserts 200 with a two-level zero-owner placeholder, `Cache-Control: public, max-age=30`, edge cache write, and no hierarchy-service call. Commit this test alone and run `pnpm test` to confirm it FAILS.
- [ ] T002 [AC2] In `src/index.ts`, in the `/registry-hierarchy/:name` catch block, add handling for `NotFoundError` with `definitive: false` BEFORE the existing fallthrough: construct a two-level zero-owner placeholder hierarchy, set `Cache-Control` via `CachePresets.error()`, call `edgeCachePut(c, res, 30)`, and return 200 JSON. Run the regression test to confirm it PASSES.
- [ ] T003 [AC3] Run `pnpm run test` on the final commit to confirm the full gate passes.