# Workhorse spec: WEB-1708 [W8-CONFIG-002] Fix testing-campaign finding on main (TDD)

## Summary

When `D1_RETENTION_SECS` is the decimal spelling of `10^309`, the daily scheduled cleanup must treat that duration as invalid and delete D1 rows with the documented 30-day default cutoff. Do that on main, test-first, for this finding only.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers, Vitest 2 under Node (see `package.json` and `vitest.config.ts`).
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile` when `node_modules` is missing.
- **Testing**: a new focused regression via `CI=true pnpm exec vitest run <file>`; the project gate `CI=true pnpm run test`. `pnpm run test` is `vitest` and watches unless `CI` is set. A watch-mode process is not a finished check.
- **Constraints**: TDD from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-CONFIG-002`. No cherry-pick or transplant from testing-campaign. No drive-by refactors. Workhorses do not push and do not touch the primary checkout.

## Direction check

- TDD, failing regression recorded before any product fix: the new test is committed and run red on the main baseline before any commit that changes product code.
- Independent fix cut from main: every commit descends from the BASE above. Do not read other branches or `.worktrees/`.
- One finding only: the diff and commit messages name `W8-CONFIG-002` and no other findings.md id.
- Out of scope, left out: other env vars, other retention bugs, and any change that is not required to make this non-finite duration fall back to the 30-day default.

## Structure

- A new focused test under `test/`, driving the Worker's scheduled handler. The lane chooses the file name.
- Product change only on the path that turns `D1_RETENTION_SECS` into the duration the scheduled cleanup uses. On main that path is `envSecsToMs` in `src/index.ts`, called by the `scheduled` handler, which passes the result to `runD1Retention`. The documented default is `D1_RETENTION_MS` in `src/services/d1.ts` (30 days). `docs/testing-campaign/` does not exist on main. Do not add it.

## Decisions

1. The acceptance surface is the Worker's scheduled handler, not a private function's return value. Call `scheduled` with a D1 binding and `D1_RETENTION_SECS` set to `1` followed by 309 zeroes. The proof is which rows remain, not what a helper returns.
2. That spelling is the minimized input. `Infinity`, `1e309`, and `1e6` are different inputs. `1e6` is already ignored because it is not digits only. Do not substitute one of those and call the criterion met.
3. Invalid means the scheduled cleanup uses the 30-day default cutoff. A row last updated more than 30 days ago is deleted. A row last updated less than 30 days ago is kept. Skipping the job, throwing, deleting every row, or keeping every row does not meet the ticket.
4. The lane chooses how a non-finite duration becomes that default. Rejecting it inside `envSecsToMs`, or refusing it at the scheduled call, are both acceptable if the handler's observable cutoff is the 30-day default. Do not special-case only the 310-digit spelling and leave another non-finite digit string accepted.
5. A finite whole-second override of at least one day must still be honored. The existing `D1_RETENTION_SECS` override is not this finding. Do not break it.
6. Do not bind a non-finite cutoff. The regression shows that by the rows: the old row is gone and the fresh row remains. It does not need to inspect the bound parameter.
7. The regression must fail on the main baseline because the old row is still present after the scheduled run. Record that failing run before any product-code commit. After the fix, the same assertions pass. Do not weaken them.
8. Workhorses do not push and do not open the pull request. The landing branch is `WEB-1708`, already cut from main at BASE. The workhorse branch is `wb/WEB-1708-<lane>`. Show that the workhorse commits descend from BASE and contain no cherry-pick from another branch.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds the test and does not change product code, run `CI=true pnpm exec vitest run <the new test file>`. Input: the Worker's `scheduled` handler, `D1_RETENTION_SECS` equal to `1` followed by 309 zeroes, a domain row last updated more than 30 days ago, and a domain row last updated less than 30 days ago. Save the command, output, and exit under `.postmaster/verify/` before the first commit that changes `src/`. | The command exits non-zero. The failure shows the row older than 30 days was not deleted. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | The same `CI=true pnpm exec vitest run <the new test file>` on the final code. The test still asserts that the row older than 30 days is deleted and the row younger than 30 days remains, for that same `D1_RETENTION_SECS` value. | Exit 0. The assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `/Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` just before writing the summary, with `CI=true` in the environment so the gate exits. | The gate check passes. Record the library check as verify.sh prints it. A library result of not-run is not a failure to paper over with a new package-name import. |
| AC4 | The change set addresses only `W8-CONFIG-002` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | Only this finding's regression and the minimal invalid-duration fix, plus the spec already committed in the worktree. No other findings.md id in the diff or messages. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format=%B 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | The ancestor check exits 0. The messages have no cherry-pick trailer and do not import testing-campaign commits. Do not push. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused failing regression under `test/` and record its failing run before any product change.
- [ ] T002 [AC1] [AC2] Make the non-finite `D1_RETENTION_SECS` duration invalid so the scheduled cleanup uses the 30-day default cutoff.
- [ ] T003 [AC2] Re-run the same focused test and keep the assertions unchanged.
- [ ] T004 [AC3] Run the recorded checks at the branch head, with `CI=true` so they exit.
- [ ] T005 [AC4] [AC5] Confirm the diff is only this finding and descends from main with no cherry-pick. Do not push.
