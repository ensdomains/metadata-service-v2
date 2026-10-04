# Workhorse spec: WEB-1710 [W8-EXPIRY-001] Fix testing-campaign finding on main (TDD)

## Summary

`evictExpiryVerdict` promises that the next `checkExpiry` re-reads the chain, including when a read started before eviction and completes afterward. On main, that in-flight read stores its live verdict after the delete, so the next request is a cache hit and only the pre-eviction chain read occurs. Fix that on main, test-first, for this finding only.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers, Vitest 2 under Node (see `package.json` and `vitest.config.ts`).
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile` when `node_modules` is missing.
- **Testing**: a new focused regression via `CI=true pnpm exec vitest run <file>`; the project gate `CI=true pnpm run test`.
- **Constraints**: TDD from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-EXPIRY-001`. No cherry-pick or transplant from testing-campaign. No drive-by refactors. Workhorses do not push. Test commands must exit; do not leave Vitest in watch mode.

## Direction check

- TDD, failing regression recorded before any product fix: the new test is committed and run red on the main baseline before any commit that changes product code.
- Independent fix cut from main: every commit descends from the BASE above. Do not read other branches or `.worktrees/`. Do not touch the primary checkout.
- One finding only: the diff and commit messages name `W8-EXPIRY-001` and no other findings.md id.
- Out of scope, left out: expiry TTL, fail-open caching, caching of an expired 410, LRU bounds, webhook signature or payload validation, and any other expiry behavior that already matches its tests.

## Structure

- A new focused test under `test/`, driving `MetadataService.checkExpiry` and `MetadataService.evictExpiryVerdict`. The lane chooses the file name.
- Product change only where an in-flight live verdict can be stored after `evictExpiryVerdict`. On main that store is `settleExpiry` in `src/services/metadata.ts`, called after the v1 `getExpiry` read the ticket names, and the delete is `evictExpiryVerdict` in the same file. The lane chooses the mechanism.
- Do not add a new module unless the existing cache type cannot express the promise. Prefer the smallest change in the files that already own the cache.
- No docs change. `docs/webhook.md` already says expiry-affecting events flush expiry caches; it does not need a race write-up.

## Decisions

1. The acceptance surface is `checkExpiry` and `evictExpiryVerdict`, the functions the ticket names. There is no route and no User journey. The chain read is the observable: how many times the paused v1 expiry read runs, and in what order relative to eviction.
2. The minimized input is: start `checkExpiry("a.eth")` on a network where the v1 registrar is authoritative, pause that `getExpiry` call, evict, let the paused read return one stable future expiry, then call `checkExpiry("a.eth")` again. The stable value is the same on every read. Both requests receive the live result: `checkExpiry` resolves, it does not throw `DomainExpiredError`.
3. Expected for that input: exactly two ordered chain reads. The first read starts before eviction and completes after it. The first request still receives that stable live result. The next request, made only after the first has settled, starts a fresh read and also receives the stable live result. One read total is the bug the ticket names.
4. Eviction is by the canonical name `a.eth`, and separately by the matching namehash. Both are in the required regression. A fix that honors only one identifier does not meet the ticket.
5. Do not make the first request fail, retry, or start its own second read because eviction happened while it was in flight. The ticket's expected count is two reads for the two requests, not three, and the pre-eviction read is the one that completes after eviction.
6. The lane chooses how a late store is prevented from satisfying the next request. Do not copy an implementation from another branch. A generation, an in-flight token, or an equivalent is acceptable only if the observables in decisions 3 through 5 hold.
7. The same promise applies to a v2 registration read that settles a live verdict: if that read started before eviction and completes after it with a stable future expiry, the next request must start a fresh read too. Include that case so a v1-only special case does not pass. It is this finding, not a second findings.md id. The required red baseline remains the named v1 input.
8. The regression must be recorded red before any product-code commit. After the fix, the same assertions pass. Do not weaken the two-read count, drop the namehash case, or drop the v2 late-store case to make a narrower patch pass.
9. Workhorses do not push and do not open the pull request. The landing branch is `WEB-1710`, already cut from main at BASE. The workhorse branch is `wb/WEB-1710-<lane>`. Show that the workhorse commits descend from BASE and contain no cherry-pick from another branch.
10. Run Vitest so it exits. `pnpm run test` is `vitest`, which watches in a TTY. Prefix focused and gate commands with `CI=true`. The recorded check name remains `pnpm run test`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds the test and does not change product code, run `CI=true pnpm exec vitest run <the new test file>`. Input: start `checkExpiry("a.eth")`, pause its live v1 `getExpiry`, evict by canonical name `a.eth` (and, in a second case, by the matching namehash), then resolve that read with one stable future expiry and call `checkExpiry("a.eth")` again. Save the command, output, and exit under `.postmaster/verify/` before the first commit that changes `src/`. | The command exits non-zero. The failure shows the next request returned from the cache the older read stored after eviction, so only the pre-eviction chain read occurred. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | The same `CI=true pnpm exec vitest run <the new test file>` on the final code. The test still asserts exactly two ordered reads, a live result for both requests, eviction by canonical name and by matching namehash, and the v2 late-store case. | Exit 0. The assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `/Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` just before writing the summary. When you run the gate yourself, use `CI=true pnpm run test` so it exits. | The gate check passes. Record the library check as verify.sh prints it. A library result of not-run is not a failure to paper over with a new package-name import. |
| AC4 | The change set addresses only `W8-EXPIRY-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | Only this finding's regression and the minimal late-store fix, plus the spec already committed in the worktree. No other findings.md id in the diff or messages. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format=%B 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | The ancestor check exits 0. The messages have no cherry-pick trailer and do not import testing-campaign commits. Do not push. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused failing regression under `test/` and record its failing run before any product change.
- [ ] T002 [AC1] [AC2] Make a chain read that started before `evictExpiryVerdict` unable to satisfy the next `checkExpiry` when it completes afterward. Keep the in-flight request's own live result.
- [ ] T003 [AC2] Re-run the same focused test and keep the assertions unchanged.
- [ ] T004 [AC3] Run the recorded checks at the branch head with a terminating gate.
- [ ] T005 [AC4] [AC5] Confirm the diff is only this finding and descends from main with no cherry-pick. Do not push.
