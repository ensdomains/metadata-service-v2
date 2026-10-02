# Workhorse spec: WEB-1660 [FALLBACK-E4-001] Fix testing-campaign finding on main (TDD)

## Summary

The chain-expiry comparison must not treat `Number(expiry) * 1000` as exact. For `expiry = 2^53 + 3` seconds and `Date.now()` equal to that rounded product, `checkExpiry("precision.eth")` throws `DomainExpiredError` (the 410 verdict). Today it resolves, because rounding makes the two sides equal even though the exact instant is 1,096 ms earlier. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. `checkExpiry` already lives on `MetadataService` in `src/services/metadata.ts` and throws `DomainExpiredError`, which the HTTP mapper turns into status 410.
- **Testing**: `pnpm exec vitest run <focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the successful resolve, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec.
- One finding, `FALLBACK-E4-001`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is the comparison at `src/services/metadata.ts:373-375`. The required demonstration is `checkExpiry("precision.eth")` with the finding's minimized input. A change that leaves that call resolving does not meet the ticket.
- The exact bigint expiry is 1,096 ms before `Number(expiry) * 1000`. Equality of the rounded sides is not "not yet expired".
- No AGENTS.md. README.md is the project context. `docs/webhook.md` and `.github/workflows/ci.yml` are the other docs to read. This ticket does not change the webhook, CI, cache TTLs, or route handlers.
- Degraded and outage responses must not be cached as healthy success. An expired verdict must not be cached as a live success. A chain read that fails must still fail open, as it does today. Do not add a cache write, and do not change a cache TTL, to make the regression pass.

## Structure

- A new focused regression under `test/`, calling `checkExpiry("precision.eth")` with the finding's expiry and `Date.now()`.
- A minimal product change so that comparison uses an exact instant, not `Number(expiry) * 1000`. The lane chooses the mechanism.
- No other finding, no new package, no webhook, route, or cache-policy change.

## Decisions

- The regression calls `checkExpiry("precision.eth")` and expects `DomainExpiredError`. The ticket names that method, that name, and that error. It does not name an HTTP route. Do not satisfy the finding only through a route test that never calls `checkExpiry`. The existing mapper already turns `DomainExpiredError` into 410; do not change that mapper.
- The chain expiry fed into the comparison is `2n ** 53n + 3n` seconds. `Date.now()` is `Number(expiry) * 1000`. Assert that this represented instant is 1,096 ms after `expiry * 1000n`, so the input cannot drift, and assert that `checkExpiry("precision.eth")` throws `DomainExpiredError`. Asserting only that some other name throws, or that the call rejects with any error, is not enough.
- How the chain read is stubbed is the lane's choice, as long as `checkExpiry("precision.eth")` receives that expiry. Do not prescribe a private helper, a mock shape, or a new type. Do not call a private method as the only assertion.
- How the comparison becomes exact is the lane's choice. Comparing the expiry in integer milliseconds without rounding through `Number` is enough. Do not prescribe a helper.
- Do not "fix" this by throwing whenever `Number(expiry)` is past `Number.MAX_SAFE_INTEGER`. A not-yet-reached exact expiry must still resolve, and expiry `0` must still mean there is no expiry. Do not add a regression that changes those existing rules; the required regression is the finding's input only.
- Do not change the indexer `expiryDate` path, the v2-versus-v1 authority rules, or fail-open when the chain read throws. Those are not this finding. An expired result of this comparison must still not be stored as a live verdict.
- Do not implement another finding. Do not edit `docs/testing-campaign/`. Do not read or copy the testing-campaign checkout.
- The lane branch stays `wb/WEB-1660-<lane>`. The pull request is opened later, against main, from `WEB-1660`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test calls `checkExpiry("precision.eth")` with chain expiry `2^53 + 3` seconds and `Date.now() = Number(expiry) * 1000`, and asserts it throws `DomainExpiredError`. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is the call resolving, because rounding makes `expiryMs === Date.now()`, not a setup error, a timeout, or a different exception. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts that `checkExpiry("precision.eth")` throws `DomainExpiredError` for that input. The assertion was not changed to accept a resolve, to accept any error, or to skip the call. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `FALLBACK-E4-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the exact expiry comparison for this finding. No other findings.md id is named as a bundled fix. No drive-by refactor of routes, cache TTLs, or indexer expiry handling. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1660`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` that calls `checkExpiry("precision.eth")` with expiry `2^53 + 3` seconds and `Date.now() = Number(expiry) * 1000`, and expects `DomainExpiredError`. Run it on the main baseline and record the successful resolve before any product fix.
- [ ] T002 [AC2] Change the cited expiry comparison so that call throws `DomainExpiredError` without assuming `Number(expiry) * 1000` is exact. Do not weaken the assertion. Do not change fail-open, expiry `0`, or the indexer `expiryDate` path.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
