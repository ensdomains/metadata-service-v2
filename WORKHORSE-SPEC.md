# Workhorse spec: WEB-1706 [W8-ROUTES-001] Fix testing-campaign finding on main (TDD)

## Summary

An invalid `MAX_BATCH_NAMES` value must not be read as a smaller batch cap. Trailing garbage is not a positive integer, so `POST /batch-metadata` uses the documented default of 100. Do that on main, test-first, for this finding only.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers, Vitest 2 under Node (see `package.json` and `vitest.config.ts`).
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile` when `node_modules` is missing.
- **Testing**: a new focused regression via `CI=true pnpm exec vitest run <file>`; the project gate `CI=true pnpm run test`.
- **Constraints**: TDD from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-ROUTES-001`. No cherry-pick or transplant from testing-campaign. No drive-by refactors. Workhorses do not push.

## Direction check

- TDD, failing regression recorded before any product fix: the new test is committed and run red on the main baseline before any commit that changes product code.
- Independent fix cut from main: every commit descends from the BASE above. Do not read other branches or `.worktrees/`.
- One finding only: the diff and commit messages name `W8-ROUTES-001` and no other findings.md id.
- Out of scope, left out: other `parseInt` call sites (`MAX_AVATAR_BYTES`, `WEBHOOK_TOLERANCE_SECS`, image dimensions, expiry parsing, rate-limit counters), other batch-limit behavior, and any testing-campaign patch.

## Structure

- A new focused test under `test/`, driving `POST /batch-metadata`. The lane chooses the file name.
- Product change only on the path that turns `MAX_BATCH_NAMES` into the batch cap. On main that path is `getMaxBatchNames` in `src/index.ts`, called by `POST /batch-metadata` before any name is resolved. The comment already says an invalid or garbage value uses the default. The code does not: `parseInt("1a", 10)` is `1`.
- `README.md` already documents the default of 100. Do not rewrite it. Change a doc sentence only if it would still say a numeric prefix is a valid cap.

## Decisions

1. The acceptance surface is the HTTP route, not a helper's return value. `POST /batch-metadata` is the interface the ticket describes. The lane chooses how an invalid env value becomes the default cap, as long as the route shows it.
2. A configured value is a positive integer only when the entire string is one or more ASCII digits and the integer value is greater than 0. No trimming. A sign, a decimal point, an exponent, surrounding whitespace, a leading or trailing non-digit, an empty string, or zero is not a positive integer.
3. Anything that is not a positive integer uses `100`, the documented default. `MAX_BATCH_NAMES="1a"` is trailing garbage, so the cap is 100, not 1. The same rule covers other trailing garbage, such as `"2xyz"`. A one-string special case for `"1a"` does not meet the ticket.
4. A real positive integer still applies. `MAX_BATCH_NAMES="1"` with two names is still HTTP 400 `Cannot process more than 1 names at once`. The fix must not ignore the env var.
5. Using the default means the default cap, not an unlimited accept. With `MAX_BATCH_NAMES="1a"`, 101 names is HTTP 400 `Cannot process more than 100 names at once`.
6. The minimized input is the one the ticket names: `MAX_BATCH_NAMES="1a"` and body `{"names":["a.eth","b.eth"]}`. Expected HTTP 200. On main today that request is HTTP 400 `Cannot process more than 1 names at once`. The regression asserts 200 for that request. Do not weaken that assertion after it has failed for that reason.
7. The 200 is the route accepting the body and returning the batch response, not an upstream success. Stub resolution the way `test/batch-metadata-limits.test.ts` already does, so the status is the cap's answer and the test does not call a live RPC. Assert HTTP 200 and `total: 2`. Do not require a particular metadata field beyond what that stub returns.
8. The existing cases in `test/batch-metadata-limits.test.ts` stay as they are: `"3"` rejects four names, `"4"` accepts them, and `"lots"` and `"0"` use the default. Do not weaken those assertions. Do not restyle that file.
9. The regression must be committed and run red, with the command, output, and exit saved, before the first commit that changes `src/`. After the fix, the same assertions pass.
10. Workhorses do not push and do not open the pull request. The landing branch is `WEB-1706`, already cut from main at BASE. The workhorse branch is `wb/WEB-1706-<lane>`. Show that the workhorse commits descend from BASE and contain no cherry-pick from another branch.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds the test and does not change product code, run `CI=true pnpm exec vitest run <the new test file>`. Input: `POST /batch-metadata` with `MAX_BATCH_NAMES="1a"` and body `{"names":["a.eth","b.eth"]}`. Save the command, output, and exit under `.postmaster/verify/` before the first commit that changes `src/`. | The command exits non-zero. The failure shows HTTP 400 `Cannot process more than 1 names at once` instead of HTTP 200. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | The same `CI=true pnpm exec vitest run <the new test file>` on the final code. The test still asserts HTTP 200 and `total: 2` for the minimized input, HTTP 400 `Cannot process more than 100 names at once` for 101 names under `MAX_BATCH_NAMES="1a"`, HTTP 400 `Cannot process more than 1 names at once` for two names under `MAX_BATCH_NAMES="1"`, and HTTP 200 for three names under another trailing-garbage value such as `"2xyz"`. | Exit 0. The assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `/Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` just before writing the summary. Run the gate as `CI=true pnpm run test` if invoking it directly, so Vitest exits. | The gate check passes. Record the library check as verify.sh prints it. A library result of not-run is not a failure to paper over with a new package-name import. |
| AC4 | The change set addresses only `W8-ROUTES-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | Only this finding's regression and the minimal cap-parsing fix, plus the spec already committed in the worktree. No other findings.md id in the diff or messages. No change to the other `parseInt` sites. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format=%B 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | The ancestor check exits 0. The messages have no cherry-pick trailer and do not import testing-campaign commits. Do not push. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused failing regression under `test/` and record its failing run before any product change.
- [ ] T002 [AC1] [AC2] Make an invalid `MAX_BATCH_NAMES` value, including trailing garbage, use the default cap of 100, while a real positive integer still applies.
- [ ] T003 [AC2] Re-run the same focused test and keep the assertions unchanged.
- [ ] T004 [AC3] Run the recorded checks at the branch head.
- [ ] T005 [AC4] [AC5] Confirm the diff is only this finding and descends from main with no cherry-pick. Do not push.
