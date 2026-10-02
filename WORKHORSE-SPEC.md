# Workhorse spec: WEB-1672 [W3-ROUTES-007] Fix testing-campaign finding on main (TDD)

## Summary

Fix a bug in the `/registry-hierarchy/:name` route handler where an `UpstreamError` thrown during the pre-service expiry check (`checkExpiry`) causes a 503 error response instead of a graceful 200 placeholder hierarchy. The route's README contract says it "never answers 404 or 503". This fix ensures that contract holds by returning a two-level zero-owner placeholder when the upstream pre-check fails, with appropriate short-lived cache headers and no call to the hierarchy service after the failure.

## Technical context

- **Language and version**: TypeScript 5.6.3, Node >=18
- **Runtime**: Cloudflare Workers (Hono)
- **Dependencies used or added**: None added. Uses existing `UpstreamError` from `src/services/errors.ts`, `CachePresets` from `src/utils/cache-headers.ts`.
- **Testing**: `pnpm run test` (vitest). Write a focused regression test that demonstrates the bug on main baseline (fails), then the fix makes it pass.
- **Constraints**: 
  - TDD: write failing test first, record it, then fix
  - One finding only (W3-ROUTES-007); no other finding changes
  - No cherry-picks or copies from the testing-campaign branch
  - Fix must not weaken the regression test assertion
  - Do not bundle drive-by refactors
  - Degraded/outage responses must not be cached as healthy success

## Direction check

| Constraint | How met |
|---|---|
| TDD: failing test first, then fix | Spec prescribes two commits: (1) add regression test that fails on main, record the failure; (2) fix the catch block |
| One finding only | Only W3-ROUTES-007 is addressed |
| No cherry-picks from testing-campaign | Regression test and fix are written fresh against main |
| Fix must not weaken regression | The regression test asserts 200 placeholder; after the fix it must pass without change |
| No drive-by refactors | Only the catch block in the registry-hierarchy route is changed |
| Outage responses not cached as healthy | Placeholder uses error-cache TTL (`max-age=30`) and is edge-cached, not marked with success TTL |

## Structure

Files changed:
- `test/registry-hierarchy-outage.test.ts` — NEW: focused regression test
- `src/index.ts` — MODIFIED: catch block in `/registry-hierarchy/:name` route handler (lines ~728-734)

## Decisions

1. **Test location**: New file `test/registry-hierarchy-outage.test.ts` rather than modifying an existing test file. The finding references `test/routes-decision-table.test.ts` which does not exist on main; a new focused test file keeps the regression isolated and clearly scoped.

2. **Test approach**: Service-level test, constructing `MetadataService` directly with mocked blockchain dependencies following the pattern in `test/outage-taxonomy.test.ts` and `test/expiry-gates.test.ts`. The test mocks the blockchain tier to throw `UpstreamError`, then verifies that `getRegistryHierarchy` does not propagate the error to the route as 503 but instead returns a placeholder. Additionally, a route-level assertion verifies the HTTP response is 200 with correct cache headers.

3. **Placeholder structure**: A two-level hierarchy: the requested name (level 2) with zero-address owner and default resolver, and `eth` (level 1) with zero-address owner and default resolver. This matches the structure described in the finding.

4. **Cache headers**: The placeholder response uses `Cache-Control: public, max-age=30` — the error-cache TTL, as stated in the finding. The placeholder is written to the edge cache via `edgeCachePut` so the short-lived degraded response is served consistently per colo.

5. **Fix scope**: The catch block in the registry-hierarchy route handler adds handling for `UpstreamError` before the generic error path. When the error is `UpstreamError`, a two-level placeholder is constructed and returned as 200 with `CachePresets.error()` headers and edge cache write — without calling `getRegistryHierarchy`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm run test test/registry-hierarchy-outage.test.ts` — on the commit that adds only the regression test, before any product fix | Test fails with assertion error: expected 200, got 503 (or equivalent). Record the failure output. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm run test test/registry-hierarchy-outage.test.ts` — on the commit with the product fix | Test passes: status 200, body has two-level placeholder with zero owners, `Cache-Control: public, max-age=30`, and `getRegistryHierarchy` was not called after the failed pre-check |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` | All tests pass, exit code 0 |
| AC4 | The change set addresses only `W3-ROUTES-007` and does not bundle another findings.md id. | `git diff BASE...HEAD --stat` | Only `src/index.ts` (catch block change) and `test/registry-hierarchy-outage.test.ts` (new test) are changed |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | Inspect the diff and commit history | No cherry-pick markers, no commits from testing-campaign |

## Tasks

- [ ] T001 [P] [AC1] Write `test/registry-hierarchy-outage.test.ts`: a focused regression test that constructs a `MetadataService` with mocked blockchain services set to throw `UpstreamError` on `checkExpiry`, calls the service path equivalent to the route handler, and asserts the result is a 200 placeholder hierarchy (not 503). Record the test failing on main baseline.
- [ ] T002 [AC2] Fix `src/index.ts` catch block in `/registry-hierarchy/:name` route handler: when `error` is `UpstreamError`, construct a two-level zero-owner placeholder, set `Cache-Control: public, max-age=30` via `CachePresets.error()`, write to edge cache via `edgeCachePut`, and return 200 — without calling `getRegistryHierarchy`.
- [ ] T003 [AC4] Verify the diff touches only the intended files: `src/index.ts` and `test/registry-hierarchy-outage.test.ts`.
- [ ] T004 [AC3] Run `pnpm run test` and verify all tests pass at the ticket branch head.