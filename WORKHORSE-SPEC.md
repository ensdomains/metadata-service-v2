# Workhorse spec: WEB-1707 [W8-CONFIG-001] Fix testing-campaign finding on main (TDD)

## Summary

`MAX_AVATAR_BYTES` must reject garbage, including a numeric prefix such as `1a`, and fall back to `AvatarService`'s built-in 25 MiB cap. Do that on main, test-first, for this finding only.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers, Vitest 2 under Node (see `package.json` and `vitest.config.ts`).
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile` when `node_modules` is missing.
- **Testing**: a new focused regression via `CI=true pnpm exec vitest run <file>`; the project gate `pnpm run test`, also under `CI=true` so Vitest exits. The recorded check command remains `pnpm run test`.
- **Constraints**: TDD from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-CONFIG-001`. No cherry-pick or transplant from testing-campaign. No drive-by refactors. Workhorses do not push.

## Direction check

- TDD, failing regression recorded before any product fix: the new test is committed and run red on the main baseline before any commit that changes product code.
- Independent fix cut from main: every commit descends from the BASE above. Do not read other branches or `.worktrees/`.
- One finding only: the diff and commit messages name `W8-CONFIG-001` and no other findings.md id.
- Out of scope, left out: other env parsers, avatar fetch policy, image allowlisting, and cache behavior, except where a change is required to stop this parse from accepting a numeric prefix.

## Structure

- A new focused test under `test/`, driving `GET /mainnet/avatar/red-team.eth`. The lane chooses the file name.
- Product change only in the `MAX_AVATAR_BYTES` parse that constructs `AvatarService`. On this base that parse is in `getImageServices` in `src/index.ts` (the comment at lines 246-248; the audit citation `src/index.ts:266-268` is the same parse). Do not change `AvatarService`'s built-in default.
- Do not refactor `envSecsToMs` or other env parsers in this ticket.

## Decisions

1. The acceptance surface is the avatar image route, not a private parser's return value. `GET /:network/avatar/:name` is the interface the ticket names. The lane chooses how the env string is parsed.
2. A value is a usable cap only when the whole string is a positive base-10 integer. Surrounding whitespace may be accepted, matching `envSecsToMs` (`/^\s*\d+\s*$/`), and the number must be greater than 0. `1a`, `1.5`, `30mb`, `1e6`, `0`, negatives, and empty are not usable caps. `parseInt` is the wrong reader: `parseInt("1a", 10)` is `1`.
3. Unset, empty, and every unusable value pass `undefined` into `AvatarService`, so its built-in default applies. That default is `25 * 1024 * 1024` (25 MiB), documented in `src/services/avatar.ts` and in the README as 25 MB. Do not hard-code a second copy of the cap in the route unless the lane can show it stays equal to that built-in default. The fallback must not be a 1-byte cap and must not be "no cap".
4. A warning when a value is ignored is allowed, in the style of `envSecsToMs`. It is not required.
5. The Worker caches image services per network in `_imageServices`. A regression must build the service under the env it asserts. Reusing a service built for another `MAX_AVATAR_BYTES` does not count. `vi.resetModules()` is one acceptable way. The lane chooses.
6. The minimized case is `MAX_AVATAR_BYTES="1a"` and `GET /mainnet/avatar/red-team.eth`. Upstream returns a valid allowlisted image larger than 1 byte and no larger than 25 MiB. After the fix the route returns HTTP 200 and those bytes. On the baseline the route discards the image (HTTP 404 `{ message: "No avatar set for red-team.eth" }`) because the cap is 1 byte.
7. The same garbage env must still discard a body larger than 25 MiB (HTTP 404). That shows the fallback is the built-in default, not the removal of the cap. A usable integer, such as `"2"`, must still discard an image larger than that integer. Do not weaken either assertion after the red run.
8. The regression must fail on the main baseline for the reason in the ticket: a valid avatar larger than one byte is discarded under `MAX_AVATAR_BYTES="1a"`. Record that failing run, command, output, and exit, before any product-code commit. After the fix, the same assertions pass.
9. Workhorses do not push and do not open the pull request. The landing branch is `WEB-1707`, already cut from main at BASE. The workhorse branch is `wb/WEB-1707-<lane>`. Show that the workhorse commits descend from BASE and contain no cherry-pick from another branch.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds the test and does not change product code, run `CI=true pnpm exec vitest run <the new test file>`. Input: `MAX_AVATAR_BYTES="1a"` and `GET /mainnet/avatar/red-team.eth`, with upstream returning a valid image larger than 1 byte and no larger than 25 MiB. Save the command, output, and exit under `.postmaster/verify/` before the first commit that changes `src/`. | The command exits non-zero. The failure shows the image was discarded (HTTP 404) instead of HTTP 200 with those bytes. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | The same `CI=true pnpm exec vitest run <the new test file>` on the final code. The test still asserts HTTP 200 and the image bytes for the minimized input, HTTP 404 for a body larger than 25 MiB under the same garbage env, and that a usable integer cap still discards an image larger than that integer. | Exit 0. The assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `CI=true /Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` just before writing the summary. | The gate check passes. Record the library check as verify.sh prints it. A library result of not-run is not a failure to paper over with a new package-name import. |
| AC4 | The change set addresses only `W8-CONFIG-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | Only this finding's regression and the minimal parse fix, plus the spec already committed in the worktree. No other findings.md id in the diff or messages. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format=%B 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | The ancestor check exits 0. The messages have no cherry-pick trailer and do not import testing-campaign commits. Do not push. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused failing regression under `test/` and record its failing run before any product change.
- [ ] T002 [AC1] [AC2] Reject an unusable `MAX_AVATAR_BYTES`, including a numeric prefix, so `AvatarService` keeps its 25 MiB default.
- [ ] T003 [AC2] Re-run the same focused test and keep the assertions unchanged.
- [ ] T004 [AC3] Run the recorded checks at the branch head.
- [ ] T005 [AC4] [AC5] Confirm the diff is only this finding and descends from main with no cherry-pick. Do not push.
