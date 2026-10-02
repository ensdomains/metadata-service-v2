# Workhorse spec: WEB-1678 [W3-ROUTES-011] Fix testing-campaign finding on main (TDD)

## Summary

Fix finding W3-ROUTES-011: the `/registry-hierarchy` route handler's catch block passes `HTTPException(404)` and `HTTPException(503)` through to `httpError()`, which returns the wrong status codes, instead of honouring the route's S3 invariant that the hierarchy route never answers 404 or 503. The fix catches those two specific HTTPException statuses in the route handler and returns a 200 root-first zero-owner placeholder with the correct cache policies per status.

## Technical context

- **Language and version**: TypeScript 5.9.2, Hono 4.x, Cloudflare Workers
- **Dependencies used or added**: None new (existing Hono `HTTPException` import already present)
- **Testing**: `pnpm run test` (vitest 2.1.9), plus a focused regression test that injects `HTTPException(404)` and `HTTPException(503)` at both the `checkExpiry` and `getRegistryHierarchy` seams
- **Constraints**: TDD on main baseline — write failing regression first, record it, then fix. One finding only (W3-ROUTES-011). No cherry-picks from testing-campaign. No drive-by refactors.

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: write failing regression first, run it on main baseline, record the failure | A focused parameterized test is added first, committed, and run against the unmodified BASE code to demonstrate the failure before any fix commit. |
| Fix only W3-ROUTES-011, no other findings | The change is scoped to the `/registry-hierarchy` route handler's catch block and one new test describe block. |
| No cherry-picks from testing-campaign | The regression test and fix are written from scratch against the main baseline. |
| `pnpm run test` must pass at the ticket branch head | The full test suite runs and passes after the fix. |
| PR against main from branch named after the ticket | Branch is `WEB-1678` (the synthesis worktree). |

## Structure

Files changed:
- `src/index.ts`: the `/registry-hierarchy` route handler's catch block — add handling for `HTTPException` with status 404 or 503 that returns a 200 placeholder hierarchy instead of delegating to `httpError`.
- `test/routes-decision-table.test.ts` (new file; or an existing routes test file): a new `describe` block with a parameterized test that injects `HTTPException(404)` and `HTTPException(503)` at both the `checkExpiry` and `getRegistryHierarchy` seams.

No new files needed.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | The fix lives in the route handler catch block, not in `httpError` | `httpError` is a shared error-to-status mapper used by every route. Changing its behaviour for HTTPException would affect all routes, not just the hierarchy route, violating the scope constraint. The S3 hierarchy totality invariant applies only to the hierarchy route. |
| D2 | Only HTTPException with status 404 or 503 is overridden; other statuses (e.g. 502) pass through unchanged | The finding is specific to "forbidden hierarchy 404/503 responses." The existing S3 test for HTTPException(502) passthrough must remain green. |
| D3 | The placeholder is a two-level zero-owner hierarchy `[{name:'eth', owner: ZERO}, {name, owner: ZERO}]` with no `_provenance` | Matches the existing `generateBasicHierarchy()` pattern in `MetadataService` and the existing hierarchy-totality tests for NotFoundError/UpstreamError at the precheck seam. |
| D4 | 404 uses normal hierarchy client/edge cache policies (`Cache-Control: public, max-age=300, stale-while-revalidate=60` client, `public, max-age=300` edge); 503 uses 30-second policies (`public, max-age=30` both) | Per the finding's expected behaviour. 404 is a definitive absence (clean miss) so normal caching is safe; 503 is an outage so short-lived caching is correct. |
| D5 | The regression test goes in `test/routes-decision-table.test.ts` | The finding's test in the testing-campaign branch lives there, and it's the natural home for route-level decision tests. If the file doesn't exist at BASE, create it as a new test file. |

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm vitest run test/routes-decision-table.test.ts -t 'gives S3 precedence over route-local HTTP'` on the BASE checkout before the fix is applied | Test fails with four assertion failures: each row returns the HTTP error status (404 or 503) with error JSON and no placeholder instead of 200 with placeholder hierarchy. The failure output is captured as evidence. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm vitest run test/routes-decision-table.test.ts -t 'gives S3 precedence over route-local HTTP'` after the fix is applied | All four parameterized rows pass. Each returns 200 with root-first zero-owner placeholder, no `_provenance`, one edge write, exact seam calls/order, and the correct cache policies per status (normal hierarchy for 404, 30-second for 503). |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` on the synthesis worktree after the fix commit | Exit 0, all tests pass. |
| AC4 | The change set addresses only `W3-ROUTES-011` and does not bundle another findings.md id. | `git diff BASE...HEAD` after the fix, verified manually | Only the hierarchy route catch block and the one new test block are changed. No other finding's code is touched. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | Verify the branch is `WEB-1678`, the base is `main` at `5a5527c7`, and `git log` shows only original commits written on this branch | Branch is `WEB-1678`, base is the waybill's BASE, all commits are original. |

## Tasks

- [ ] T001 [P] [AC1] Write the focused regression test: a new `describe` block in `test/routes-decision-table.test.ts` with a parameterized `it.each` test covering all four combinations (checkExpiry seam × HTTP 404/503, getRegistryHierarchy seam × HTTP 404/503). Mock `MetadataService.prototype.checkExpiry` and `getRegistryHierarchy` to throw `new HTTPException(status)`. Assert 200 status, zero-owner placeholder, no provenance, correct cache headers per status, one edge write, and correct seam call order. Commit this test first.
- [ ] T002 [P] [AC1] Run the regression test against the unmodified BASE code to confirm it fails as the finding describes. Record the failure output.
- [ ] T003 [AC2] Implement the fix in `src/index.ts`: in the `/registry-hierarchy` catch block, before the `httpError` call, check if `error instanceof HTTPException` and `(error.status === 404 || error.status === 503)`. If so, generate a two-level zero-owner placeholder hierarchy, set the appropriate cache headers (normal hierarchy for 404, 30-second for 503), write to edge cache, and return a 200 JSON response. Commit the fix.
- [ ] T004 [AC2] Re-run the focused regression test to confirm it passes with all assertions intact.
- [ ] T005 [AC3] Run the full project gate `pnpm run test` and verify exit 0.
- [ ] T006 [AC4] Verify the diff touches only the hierarchy route handler and the one test block.