# Workhorse spec: WEB-1661 [FALLBACK-S2-001] Fix testing-campaign finding on main (TDD)

## Summary

Terminal absence is definitive only when every consulted tier, including an actually consulted primary, cleanly missed. A disabled primary was not consulted, so `NotFoundError.definitive` must be false. Today a disabled primary plus a v1 clean miss and a chain clean miss throws `NotFoundError` with `definitive === true`. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. `FallbackService` in `src/services/fallback.ts` already throws the terminal `NotFoundError`. `NotFoundError.definitive` is defined in `src/services/errors.ts`.
- **Testing**: `pnpm exec vitest run test/fallback-s2-001.test.ts` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the `definitive === true` failure, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec.
- One finding, `FALLBACK-S2-001`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is the terminal not-found after a disabled primary, a v1 clean miss, and a chain clean miss. A change that still throws `NotFoundError` with `definitive === true` for that input does not meet the ticket.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` and `.github/workflows/ci.yml` are the other docs to read. This ticket does not change the webhook, CI, or HTTP route handlers.
- Degraded and outage responses must not be cached as healthy success. Callers already treat `definitive === false` as "the primary was not consulted": D1 may still rescue, and the metadata cache must not evict on that miss. Do not retune cache TTLs, edge cache headers, or those callers to make the regression pass. Fix the flag.

## Structure

- A new focused regression at `test/fallback-s2-001.test.ts`, driving `FallbackService.getDomainMetadata` with the minimized input the finding names.
- A minimal product change so that terminal absence is not marked definitive when the primary was disabled. The lane chooses the mechanism.
- No other finding, no new package, no webhook, route, or cache-policy change.

## Decisions

- The regression calls `FallbackService.getDomainMetadata`. That is the public operation the existing suite uses to walk primary, then v1, then chain. The ticket names that walk and `NotFoundError.definitive`, not an HTTP route. Do not satisfy the finding only through a route test that never reaches the terminal not-found.
- Minimized input, built the way the existing suite already models clean misses: `indexerV2.enabled` false; the v1 indexer returns `{ domain: null }`; the chain resolver returns a zero owner. The name is `ghost.eth`. The primary `getDomain` must not be called.
- The assertion that must fail on the main baseline and must not be weakened: the thrown error is a `NotFoundError` and `definitive === false`. Asserting only that some error was thrown is not enough. Asserting `definitive === true` is the bug, not the fix.
- Same file, separate case, must keep passing: primary enabled, primary clean miss (`{ domain: null }`), v1 clean miss, chain clean miss, throws `NotFoundError` with `definitive === true`, and the primary `getDomain` was called. A fix that sets `definitive` false for every terminal miss does not meet the invariant that an actually consulted primary clean miss is definitive.
- How the flag is computed is the lane's choice. `v2Consulted` is already false when the primary is disabled and true when the primary cleanly missed. Do not prescribe an expression, a new field, or a new error type.
- A disabled primary is a skip, same as an open circuit breaker: it is not a consulted clean miss. Do not call the primary callback when it is disabled. Do not mark the indexer unhealthy because it was disabled.
- An upstream failure on a consulted tier still throws `UpstreamError`, not `NotFoundError`. Do not change that. Do not change breaker-open behavior: a skipped primary already leaves the miss non-definitive when the primary is enabled.
- Do not change `src/services/metadata.ts` or `src/services/metadata-cache.ts`. They already branch on `definitive`. This finding is the flag those callers trust.
- The comment on `NotFoundError.definitive` may be updated so it does not imply a disabled primary is proof of absence. That comment change is optional and is not a second finding.
- Do not implement another finding. Cache-header and route findings that consume `definitive` are out of scope.
- The lane branch stays `wb/WEB-1661-<lane>`. The pull request is opened later, against main, from `WEB-1661`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run test/fallback-s2-001.test.ts`. The disabled-primary case calls `getDomainMetadata('ghost.eth')` with `indexerV2.enabled` false, a v1 `{ domain: null }` miss, and a chain zero-owner miss, and asserts `NotFoundError` with `definitive === false` and that primary `getDomain` was not called. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is that case throwing `NotFoundError` with `definitive === true`. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run test/fallback-s2-001.test.ts` again. | Exit 0. The disabled-primary case still asserts `definitive === false` and that primary `getDomain` was not called. The consulted-primary case still asserts `definitive === true`. The assertion was not changed to accept `definitive === true` for a disabled primary, and was not skipped. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `FALLBACK-S2-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the terminal-definitive flag for a disabled primary. No other findings.md id is named as a bundled fix. No route, cache-TTL, or webhook change. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1661`. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/fallback-s2-001.test.ts` with the disabled-primary case (`definitive === false`, primary not called) and the consulted-primary case (`definitive === true`). Run it on the main baseline and record the `definitive === true` failure before any product fix.
- [ ] T002 [AC2] Change the terminal not-found so a disabled primary is not treated as definitive. Do not weaken the assertion. Do not change cache policy or route handlers.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
