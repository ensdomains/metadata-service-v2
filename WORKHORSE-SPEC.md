# Workhorse spec: WEB-1696 [W8-WEBHOOK-003] Fix testing-campaign finding on main (TDD)

## Summary

A fully shaped unauthenticated-dev webhook for `red-team.eth` whose `tx_hash` is `null` must be rejected with 400 and must not purge or warm caches, because `tx_hash` is documented as a string and is not checked today. Ship that as a TDD fix on a branch cut from main: commit and record a failing focused regression first, then the smallest validation change that makes that same test pass.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers (Hono). Node and pnpm as the repo already uses.
- **Dependencies used or added**: none added. Use the existing Vitest suite.
- **Testing**: `pnpm exec vitest run test/webhook-tx-hash-null.test.ts` for the focused regression; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is missing.
- **Constraints**: one finding only (`W8-WEBHOOK-003`); TDD on the main baseline; no copy, cherry-pick, or transplant from `testing-campaign` or any other worktree; no drive-by refactors; do not push.

## Direction check

- TDD, failing regression first, recorded before any product fix commit: tasks T001 and T002 are the test and the recorded failure; T003 is the first product change, and it comes after that record.
- Independent fix cut from committed main (`5a5527c7e7ac7c20140bdd81757c5bd075bd389a`): the worktree branch is already cut from that commit. Do not rebase onto or cherry-pick from `testing-campaign`.
- Do not copy testing-campaign code or tests: implement from this spec and from `README.md`, `docs/webhook.md`, and `src/services/webhook.ts` on this branch only. Do not read other branches or `.worktrees/`.
- Out of scope: every other findings id, and any refactor that is not required to reject a non-string `tx_hash` before side effects.
- Project contract: `docs/webhook.md` already documents `tx_hash` as a string. `README.md` describes `POST /webhook` as the HMAC-authenticated cache purge. There is no `AGENTS.md`. The risk surface is webhook cache purging: a bad identity field must not invalidate cache.
- No departure from the ticket direction.

## Structure

- `test/webhook-tx-hash-null.test.ts` — new focused regression. Create it. Do not edit unrelated tests.
- `src/services/webhook.ts` — reject a non-string `tx_hash` inside payload validation, before `processWebhookEvent`.
- `docs/webhook.md` — say that validation requires `tx_hash` to be a string, and that a bad `tx_hash` is a 400.
- `.postmaster/verify/` — transcripts of the failing run, the passing rerun, the gate, and the scope/history checks. This directory is gitignored; it is evidence, not part of the product diff.

## Decisions

- **Only `tx_hash`.** The finding's minimized input and expected outcome name `tx_hash`. Do not add runtime checks for `protocol`, `block_number`, `log_index`, `contract_address`, or `data` in this change. Those holes are not this finding, and the ticket forbids bundling another findings id.
- **A string, including the empty string.** The documented shape is `string`, not non-empty string. `null`, a number, a boolean, an object, an array, and a missing `tx_hash` are rejected. `""` stays accepted. The required regression is the finding's case: `null`.
- **One check for every payload.** The `tx_hash` check runs in payload validation before any purge, including when the event has no name. Do not special-case "only when a name is present".
- **Reject in the service, before side effects.** `WebhookService.handleWebhook` must return 400 before `processWebhookEvent`. That is what stops the six internal cache deletes and the batch invalidation. `src/index.ts` already skips edge purge and warming unless the service returns 2xx, so a 400 from the service is enough to stop warming. Do not change `src/index.ts` unless a check shows warming still runs on this 400.
- **Error text.** `400` with JSON `{ "error": "tx_hash must be a string" }`. The finding states that `tx_hash` is required to be a string; the message says that, so the assertion can lock the requirement. Do not use a generic validation error that does not name `tx_hash`.
- **Unauthenticated-dev path.** The regression uses `allowUnauthenticated: true` (the `WEBHOOK_ALLOW_UNAUTHENTICATED` dev escape). The event is otherwise fully shaped and valid, name `red-team.eth`. The 400 must be caused by `tx_hash`, not by auth.
- **Where the test drives.** Call `WebhookService.handleWebhook` with a request whose body is the JSON event, the same public handler `POST /webhook` uses. Assert on the response and on the cache fakes the service writes through (`cache.delete`, `cache.deleteByPrefix`, metadata KV delete, SVG KV delete, storage delete and `deleteByPrefix`). Do not assert a private helper's name.
- **TDD order is part of the fix.** The first commit after the spec, on this branch, adds the regression and no product code. Run it and save the failing transcript before any commit that changes `src/` or `docs/`. Do not amend the test commit to include the fix. Do not weaken the assertion after seeing it fail.
- **Pull request.** Do not push and do not open a pull request. Landing opens it from branch `WEB-1696` onto `main`. This lane shows that its own branch is cut from the main baseline and contains no cherry-pick.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On this branch, after the commit that adds only `test/webhook-tx-hash-null.test.ts`, run `pnpm exec vitest run test/webhook-tx-hash-null.test.ts`. Save the command, the output, and the exit code to `.postmaster/verify/ac1-failing-baseline.txt`. The test posts a fully shaped unauthenticated-dev event for `red-team.eth` with `tx_hash: null` through `WebhookService.handleWebhook`. | Exit non-zero. The failure is the assertion that the response is 400 with error `tx_hash must be a string` and that no cache delete or batch invalidation ran — on this baseline the handler returns 200 and the deletes run. Not a syntax or harness crash. `git log --reverse --format='%H %s' 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` shows that test commit before every commit that changes `src/` or `docs/`. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | At the branch head, run `pnpm exec vitest run test/webhook-tx-hash-null.test.ts` again. Save the command, output, and exit to `.postmaster/verify/ac2-focused-pass.txt`. Compare the test file with the failing commit: `git diff <failing-test-commit> -- test/webhook-tx-hash-null.test.ts`. | Exit 0. The test still asserts status 400, error `tx_hash must be a string`, and that `cache.delete`, `cache.deleteByPrefix`, metadata KV delete, SVG KV delete, and storage delete / `deleteByPrefix` were not called for the `tx_hash: null` event. The diff does not remove or loosen those assertions. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head, run `pnpm run test`. Save the command, output, and exit to `.postmaster/verify/ac3-gate.txt`. | Exit 0. |
| AC4 | The change set addresses only `W8-WEBHOOK-003` and does not bundle another findings.md id. | `git diff --name-only 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git diff 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Save both to `.postmaster/verify/ac4-scope.txt`. | Names only `test/webhook-tx-hash-null.test.ts`, `src/services/webhook.ts`, `docs/webhook.md`, `WORKHORSE-SPEC.md`, and `WORKHORSE-SUMMARY.md`. The diff mentions `W8-WEBHOOK-003` only if a comment or message needs the id, and mentions no other `W8-` findings id. No unrelated refactor. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git rev-parse --abbrev-ref HEAD`; `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format='%s%n%b' 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Save the command, output, and exit to `.postmaster/verify/ac5-history.txt`. Do not push. | The branch is `wb/WEB-1696-alpha` or `wb/WEB-1696-beta`, the baseline commit is an ancestor, and no commit message is a cherry-pick from `testing-campaign`. Opening the pull request from `WEB-1696` onto `main` is landing's step, not this lane's. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/webhook-tx-hash-null.test.ts`. It builds `WebhookService` with `allowUnauthenticated: true` and cache fakes, and calls `handleWebhook` with a fully shaped event (`event_type`, `protocol`, `block_number`, `log_index`, `contract_address`, `name`, `namehash`, `data`, `timestamp` all valid) for `red-team.eth` and `tx_hash: null`. Assert status 400, JSON error `tx_hash must be a string`, and that none of the cache, metadata KV, SVG KV, or storage deletes ran. Commit this file alone.
- [ ] T002 [AC1] Run `pnpm exec vitest run test/webhook-tx-hash-null.test.ts` on that commit. Save the failing transcript to `.postmaster/verify/ac1-failing-baseline.txt` before any product fix commit. Confirm the failure is the 200-and-deletes behavior, not a broken test.
- [ ] T003 [AC2] In `src/services/webhook.ts` payload validation, reject a `tx_hash` that is not a string with 400 and error `tx_hash must be a string`, before `processWebhookEvent`. No other identity-field checks. No change to `src/index.ts`.
- [ ] T004 [AC2] [AC4] Update `docs/webhook.md`: the validation list says `tx_hash` must be a string, and the 400 row includes an invalid `tx_hash`. No other doc edits.
- [ ] T005 [AC2] Re-run `pnpm exec vitest run test/webhook-tx-hash-null.test.ts`. Save `.postmaster/verify/ac2-focused-pass.txt`. Do not weaken the test.
- [ ] T006 [AC3] Run `pnpm run test`. Save `.postmaster/verify/ac3-gate.txt`.
- [ ] T007 [AC4] [AC5] Record the scope diff and the history check under `.postmaster/verify/ac4-scope.txt` and `.postmaster/verify/ac5-history.txt`.
