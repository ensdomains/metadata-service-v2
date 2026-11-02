# Workhorse spec: WEB-1709 [W8-MEDIA-001] Fix testing-campaign finding on main (TDD)

## Summary

`fetchMediaUrl` must follow only Fetch redirect statuses 301, 302, 303, 307, and 308. An HTTP 300 that carries `Location` is a final response after one guarded fetch, not a hop to the second URL. Do that on main, test-first, for this finding only.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers, Vitest 2 under Node (see `package.json` and `vitest.config.ts`).
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile` when `node_modules` is missing.
- **Testing**: a new focused regression via `CI=true pnpm exec vitest run <file>`; the project gate `CI=true pnpm run test`.
- **Constraints**: TDD from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-MEDIA-001`. No cherry-pick or transplant from testing-campaign. No drive-by refactors. Workhorses do not push. Test commands must exit; do not leave Vitest in watch mode.

## Direction check

- TDD, failing regression recorded before any product fix: the new test is committed and run red on the main baseline before any commit that changes product code.
- Independent fix cut from main: every commit descends from the BASE above. Do not read other branches or `.worktrees/`. Do not touch the primary checkout.
- One finding only: the diff and commit messages name `W8-MEDIA-001` and no other findings.md id.
- Out of scope, left out: redirect body-header stripping, avatar or CCIP request budgets, SSRF deny-list changes, and any other media behavior that already matches the Fetch redirect set.

## Structure

- A new focused test under `test/`, driving `fetchMediaUrl`. The lane chooses the file name.
- Product change only in `src/services/media-fetch.ts`, where a 3xx with `Location` is treated as a redirect. On main that check is the status range `300 <= status < 400` around the lines the ticket names.
- Do not add a new module. Do not change callers in `src/services/avatar.ts` or `src/services/ccip-request.ts` unless a type error in those files is caused by this change, which it should not be.
- No docs change. README does not claim that every 3xx is a redirect.

## Decisions

1. The acceptance surface is `fetchMediaUrl`, the function the ticket names. There is no route and no User journey. The minimized input is the check: `fetchMediaUrl("https://first.example/image")` when that URL's response is HTTP 300 with `Location: https://second.example/image`.
2. Expected behavior for that input is the 300 response itself, after exactly one fetch of `https://first.example/image`. The second URL is not requested. The returned status is 300, not the second URL's 200. If the 300 has a body, that body is the body returned. Do not fetch the `Location` target and then synthesize a 300.
3. A redirect, for this finding, is only status 301, 302, 303, 307, or 308, and only when `Location` is present. Any other 3xx is a final response even when `Location` is present, including 300, 304, 305, and 306. A fix that special-cases only 300 and still follows another 3xx does not meet the invariant.
4. The required regression case is the ticket's 300 input, and it must fail on the main baseline because the second URL is fetched and its 200 is returned. Also include one other non-redirect 3xx that carries `Location`, so a 300-only special case fails the same test. 304 is enough. Do not replace the 300 case with that extra case.
5. Statuses 301, 302, 303, 307, and 308 keep today's follow behavior, including the existing method rewrite for 303 and for 301/302 after POST. Do not stop following those. Do not change header or body handling of a response that is actually followed. That is a different finding.
6. The regression must be recorded red before any product-code commit. After the fix, the same assertions pass. Do not weaken them, and do not delete the extra non-redirect 3xx case to make a 300-only patch pass.
7. Workhorses do not push and do not open the pull request. The landing branch is `WEB-1709`, already cut from main at BASE. The workhorse branch is `wb/WEB-1709-<lane>`. Show that the workhorse commits descend from BASE and contain no cherry-pick from another branch.
8. Run Vitest so it exits. `pnpm run test` is `vitest`, which watches in a TTY. Prefix focused and gate commands with `CI=true`. The recorded check name remains `pnpm run test`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds the test and does not change product code, run `CI=true pnpm exec vitest run <the new test file>`. Input: `fetchMediaUrl("https://first.example/image")` where that fetch returns HTTP 300 with `Location: https://second.example/image` and a distinctive body, and the second URL would return HTTP 200. Save the command, output, and exit under `.postmaster/verify/` before the first commit that changes `src/`. | The command exits non-zero. The failure shows the second URL was fetched and/or the returned status is 200 instead of the 300 response after one fetch. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | The same `CI=true pnpm exec vitest run <the new test file>` on the final code. The test still asserts status 300, the first response body, one fetch of `https://first.example/image`, and that `https://second.example/image` was not fetched. The other non-redirect 3xx case is still there. | Exit 0. The assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `/Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` just before writing the summary. When you run the gate yourself, use `CI=true pnpm run test` so it exits. | The gate check passes. Record the library check as verify.sh prints it. A library result of not-run is not a failure to paper over with a new package-name import. |
| AC4 | The change set addresses only `W8-MEDIA-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | Only this finding's regression and the minimal redirect-status fix, plus the spec already committed in the worktree. No other findings.md id in the diff or messages. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format=%B 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | The ancestor check exits 0. The messages have no cherry-pick trailer and do not import testing-campaign commits. Do not push. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused failing regression under `test/` and record its failing run before any product change.
- [ ] T002 [AC1] [AC2] Follow only 301, 302, 303, 307, and 308 in `src/services/media-fetch.ts`. Return any other 3xx, including 300 with `Location`, after the one fetch that produced it.
- [ ] T003 [AC2] Re-run the same focused test and keep the assertions unchanged.
- [ ] T004 [AC3] Run the recorded checks at the branch head with a terminating gate.
- [ ] T005 [AC4] [AC5] Confirm the diff is only this finding and descends from main with no cherry-pick. Do not push.
