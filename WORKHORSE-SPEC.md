# Workhorse spec: WEB-1669 [W3-STATUS-001] Fix testing-campaign finding on main (TDD)

## Summary

An `HTTPException` that reaches a route catch must keep its HTTP status. Show it with `GET /migration-status/status-table.eth` while `MetadataService.checkExpiry()` throws `new HTTPException(504)`: the response is 504, not the 500 the generic error branch returns today. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Hono, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. Use the existing `HTTPException` from `hono/http-exception` and the existing app request path.
- **Testing**: `pnpm exec vitest run <focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only. A 504 must not be stored as a healthy success.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the 500-instead-of-504 failure, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec.
- One finding, `W3-STATUS-001`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is the shared error mapper's generic branch returning 500. The required demonstration is the migration-status request in the finding. A change that leaves that request at 500 does not meet the ticket.
- Degraded and outage responses must not be cached as healthy success. The 504 from this request must not be written to the per-colo edge cache as a successful migration-status payload, and must not carry the healthy migration-status cache headers.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` is out of scope unless a mistake in the fix touches the webhook.

## Structure

- A new focused regression under `test/`, driving the public route named in the finding.
- A minimal product change on the route-catch error path that currently flattens an `HTTPException` to 500. The lane chooses the mechanism.
- No other finding, no new package, no webhook, cache-TTL, or unrelated route change.

## Decisions

- The regression hits `GET /migration-status/status-table.eth` on the real app, with `MetadataService.checkExpiry()` throwing `new HTTPException(504)`. It asserts status 504. It does not call the private mapper directly, and it does not accept 500.
- How the status is preserved is the lane's choice. The existing app error handler already keeps an `HTTPException` that it actually receives. The defect is a route catch handing that exception to the generic 500 branch before that handler sees it. Either shape is acceptable if the minimized input returns 504 and a route catch no longer flattens an `HTTPException` to 500.
- The finding does not specify the response body. Do not assert a body the ticket does not require. Do not leak a new internal detail beyond what an `HTTPException` response already exposes.
- The lane branch stays `wb/WEB-1669-<lane>`. The pull request is opened later, against main, from `WEB-1669`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test requests `GET /migration-status/status-table.eth` with `MetadataService.checkExpiry()` throwing `new HTTPException(504)` and asserts status 504. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is status 500, not 504. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts status 504 for that input. The assertion was not changed to accept 500, to accept either status, or to skip the status check. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W3-STATUS-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the status-preserving fix for this finding. No other findings.md id is named as a bundled fix. No drive-by refactor. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1669`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` for `GET /migration-status/status-table.eth` with `checkExpiry` throwing `HTTPException(504)`, run it on the main baseline, and record the 500-vs-504 failure before any product fix.
- [ ] T002 [AC2] Make an `HTTPException` that reaches a route catch keep its HTTP status, so that same test returns 504. Do not weaken the assertion. Do not store that 504 as a healthy success.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
