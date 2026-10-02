# Workhorse spec: WEB-1673 [W3-ROUTES-008] Fix testing-campaign finding on main (TDD)

## Summary

Fix an S3 regression in the registry hierarchy endpoint (`GET /registry-hierarchy/:name`) where a definitive `NotFoundError` from the pre-service expiry gate (`checkExpiry`) causes the route to return a 404 error JSON instead of the contractually required 200 zero-owner placeholder with normal cache policies. The registry hierarchy route is documented as "total" — it must never answer 404 or 503 — but when `MetadataService.checkExpiry()` throws `NotFoundError({ definitive: true })`, the error falls through to `httpError()`, which returns `{ error: 'Not found', timestamp }` with status 404, no `Cache-Control` header, and no edge write.

## Technical context

- **Language and version**: TypeScript (Cloudflare Workers + Hono)
- **Dependencies used or added**: None added. The fix uses existing modules only (`CachePresets`, `edgeCachePut`, `NotFoundError` from `src/services/errors`).
- **Testing**: `pnpm run test` (Vitest). A focused regression test in a new or existing test file under `test/` exercises the route with a mocked `checkExpiry` that throws `NotFoundError({ definitive: true })` and asserts the 200 placeholder response, cache headers, edge write, and absence of hierarchy-service calls.
- **Constraints**:
  - Fix only finding W3-ROUTES-008; do not bundle W3-ROUTES-007, W3-ROUTES-009, W3-ROUTES-010, or W3-ROUTES-011.
  - TDD: write and run a failing regression test on the main baseline first, record the failure, then implement the fix.
  - Do not copy, cherry-pick, or transplant the testing-campaign branch's implementation or tests.
  - The fix must pass `pnpm run test` on the ticket branch.
  - Risk surfaces: public Cloudflare Worker HTTP routes; KV/R2/D1 and per-colo edge caching; degraded/outage responses must not be cached as healthy success.

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD on main baseline only | The first commit adds a focused regression test that fails on the main baseline. After recording the failure, the fix commit makes it pass. |
| One finding only (W3-ROUTES-008) | The fix handles only the definitive `NotFoundError` from `checkExpiry` in the registry hierarchy endpoint. Other error types (non-definitive NotFoundError, UpstreamError, HTTPException, direct hierarchy-service failures) stay unchanged. |
| No cherry-picks from testing-campaign | All code is written against the main baseline. The approach refactors the catch block inline rather than adding a general-purpose `registryHierarchyFailureResponse` function that the testing-campaign branch uses. |
| Do not weaken the regression | The regression test asserts status 200, the exact two-level zero-owner placeholder shape, normal `Cache-Control` headers (client: `public, max-age=300, stale-while-revalidate=60`, edge: `public, max-age=300`), edge write, no hierarchy-service call, and no `_provenance` field. |

## Structure

- `src/index.ts` — registry hierarchy endpoint (lines ~715–735): add an early-return path for `NotFoundError` from `checkExpiry` before it reaches `httpError`.
- A test file under `test/` — focused regression test that mocks `checkExpiry` throwing `NotFoundError({ definitive: true })` and asserts the full expected response.

## Decisions

- **Only definitive NotFoundError from checkExpiry is fixed.** The ticket addresses W3-ROUTES-008 only. A `NotFoundError` from the `getRegistryHierarchy` call (W3-ROUTES-010), a non-definitive `NotFoundError` from `checkExpiry` (W3-ROUTES-009), an `UpstreamError` from `checkExpiry` (W3-ROUTES-007), and `HTTPException` cases (W3-ROUTES-011) are left for their own tickets.
- **Test file placement.** The regression test goes in a new file `test/hierarchy-totality-definitive-miss.test.ts` or is added to the existing `test/hierarchy-concurrency.test.ts`, whichever keeps the test focused and self-contained.
- **Zero-owner placeholder shape.** The placeholder is constructed inline: `{ name, hierarchy: labels.map(...) }` with `owner: '0x0000000000000000000000000000000000000000'` and the network's resolver address for each label level, matching the documented `RegistryHierarchyResponse` type.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm run test` on the branch with only the regression test commit (before the fix). | The regression test fails with status 404 or the wrong body, demonstrating the bug. The failure output is captured. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm run test` on the branch with both the test and the fix. | The regression test passes; all assertions remain at the level of the finding. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` in the synthesis worktree at the final commit. | Exit 0; no test failures. |
| AC4 | The change set addresses only W3-ROUTES-008 and does not bundle another findings.md id. | Review the diff against BASE; grep the diff for other finding ids or their keywords (UpstreamError from checkExpiry, non-definitive NotFoundError, HTTPException in hierarchy, getRegistryHierarchy errors). | The diff contains only the W3-ROUTES-008 fix: handling `NotFoundError` from `checkExpiry` in the hierarchy route. Other error paths in the same catch block are unchanged. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git log --oneline` on the branch. | All commits are authored on this branch; none reference testing-campaign commit hashes. |

## Tasks

- [ ] T001 [P] [AC1] Write a focused regression test that mocks `MetadataService.checkExpiry` throwing `NotFoundError({ definitive: true })` on the registry hierarchy endpoint and asserts 200 status, two-level zero-owner placeholder, normal `Cache-Control` headers, edge write, no hierarchy-service call, and no `_provenance`.
- [ ] T002 [AC1] Commit the failing test and run `pnpm run test` to record the failure.
- [ ] T003 [AC2] [AC4] In `src/index.ts`, add handling in the registry hierarchy endpoint's catch block: when the error is a `NotFoundError` from `checkExpiry`, return a 200 JSON placeholder with zero-owner entries, normal `Cache-Control` (client: `public, max-age=300, stale-while-revalidate=60`, edge: `public, max-age=300`), and an edge write.
- [ ] T004 [AC2] [AC3] Run `pnpm run test`; verify the regression test passes and the full suite is green.
- [ ] T005 [AC5] Verify the branch commits are independent of testing-campaign and the diff addresses only W3-ROUTES-008.