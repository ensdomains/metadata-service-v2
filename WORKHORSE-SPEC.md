# Workhorse spec: WEB-1698 [W8-WEBHOOK-005] Fix testing-campaign finding on main (TDD)

## Summary

Reject a webhook event whose `contract_address` is not a string, before any cache purge or warming, and prove it with a focused regression that fails on main. The minimized case is a fully shaped unauthenticated-dev event for `red-team.eth` with `contract_address: 0` (a number). Today that returns 200 and runs six internal cache deletes plus batch invalidation, because payload validation never checks `contract_address`. It must return 400 and invalidate nothing.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers + Hono. No new dependency.
- **Dependencies used or added**: none. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Testing**: focused regression `CI=true pnpm exec vitest run test/webhook-contract-address.test.ts`; project gate `CI=true pnpm run test` (`pnpm run test` is `vitest`, which watches unless `CI` is set).
- **Constraints**: TDD on the main baseline only. One finding, `W8-WEBHOOK-005`. No cherry-pick from testing-campaign. No drive-by refactor. No other identity-field check.

## Direction check

- **TDD, failing regression recorded before any product fix.** The first product-facing commit adds only `test/webhook-contract-address.test.ts`. Run that file on that commit and save the transcript before the fix commit. The failure must be the finding's failure (200, and cache invalidation ran), not a broken test.
- **Minimal fix after that recording.** Only then reject a non-string `contract_address` before purge or warming. Rerun the same file without editing its assertion.
- **Only `W8-WEBHOOK-005`.** Do not add runtime checks for `protocol`, `block_number`, `tx_hash`, `log_index`, `namehash`, `data`, or any other field. Those are other findings.
- **No testing-campaign transplant.** Write the test and the fix from this spec and from the code in your worktree. Do not read other branches or `.worktrees/`.
- **Independent branch from main.** Your branch is already cut from `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Do not push and do not open a pull request. The run lands `WEB-1698` against main.
- **Documented primitive, not a new address format.** `docs/webhook.md` already types `contract_address` as a string. Match that primitive. Do not require non-empty, `0x`, length, or a checksum.

## Structure

- `test/webhook-contract-address.test.ts` — new focused regression. Drive `WebhookService.handleWebhook` the way `test/webhook.test.ts` already does: unauthenticated-dev (`allowUnauthenticated: true`), a real request body, and cache fakes.
- `src/services/webhook.ts` — the payload check that already runs before cache side effects. Reject a non-string `contract_address` there, so `processWebhookEvent` and the route's 2xx warming path never run.
- `docs/webhook.md` — one validation bullet, so the enforced list names `contract_address` as a required string. No other doc edit.

Do not edit `src/index.ts`. A 400 from the service already skips its warming path.

## Complexity tracking

None. The direction check has no departure.

## Decisions

- **This finding is only `contract_address`.** The shared invariant mentions identity fields in the plural. This ticket's minimized input, expected result, and acceptance criterion 4 name one field. A check for any other field bundles another finding and is out of scope.
- **A string is the whole requirement.** `typeof contract_address === 'string'` is the check. The number `0` fails it. So do `null`, a boolean, an object, and a missing field; that is the same check, not extra findings. `""` and `"0x"` are strings and must still be accepted. Do not add address-format validation.
- **The observable failure is the handler, not a private helper.** The regression posts a fully shaped event for `red-team.eth` with `contract_address` set to the number `0`, through the unauthenticated-dev path. It asserts status 400, a body that states `contract_address` is required to be a string, and that no cache invalidation ran: `cache.delete` not called, batch `deleteByPrefix` not called, and the metadata, SVG, and storage deletes not called.
- **Wording.** The 400 JSON `error` must contain `contract_address` and `string`. Exact sentence is yours, as long as those words are present, so the assertion cannot be weakened to "any 400".
- **A string still invalidates.** The same file includes one control: the same event with `contract_address: "0xdef"` still returns 200 and still invalidates. A fix that rejects every event is not this finding's fix.
- **Docs.** Add a single validation bullet in `docs/webhook.md`. The body schema already says `contract_address` is a string; the enforced-validation list does not. Do not rewrite the page.
- **You do not open the pull request.** Criterion 5 is shown by ancestry: every commit is yours, on a branch cut from main at the BASE above, with no testing-campaign commit in `git log BASE..HEAD`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On the commit that adds only `test/webhook-contract-address.test.ts`, run `CI=true pnpm exec vitest run test/webhook-contract-address.test.ts`. The input inside that test is a fully shaped unauthenticated-dev event for `red-team.eth` with `contract_address` set to the number `0`. Save the transcript, including `git rev-parse HEAD`, the command, the output, and the exit code, to `.postmaster/verify/ac1-baseline-fail.txt` before any product fix commit. | Exit non-zero. The failure shows status 200 rather than 400, and cache invalidation ran (internal `cache.delete` calls, plus batch invalidation). Not a compile error and not a missing-file error. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | Same command, on the fix commit. Then `git diff <test-only-commit> HEAD -- test/webhook-contract-address.test.ts`. | Exit 0. The diff of the test file is empty. The assertion still requires 400, a body stating that `contract_address` is required to be a string, and no cache invalidation, for `contract_address: 0`. The string control still expects 200 and invalidation. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `CI=true pnpm run test` at the branch head. `CI=true` is required so vitest exits; the script under test is still `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W8-WEBHOOK-005` and does not bundle another findings.md id. | `git diff --name-only 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git diff 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD`. | Only `test/webhook-contract-address.test.ts`, `src/services/webhook.ts`, and `docs/webhook.md`. The diff mentions no other `W8-` id, and it does not add a check for another identity field. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push. | The ancestor check exits 0. The log contains only commits written on this branch. No testing-campaign SHA. The pull request itself is opened later from `WEB-1698` against main; opening it is not this lane's step. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/webhook-contract-address.test.ts` as specified above. Commit that file alone.
- [ ] T002 [AC1] Run the focused file on that commit and save `.postmaster/verify/ac1-baseline-fail.txt` before any product change.
- [ ] T003 [AC2] Reject a non-string `contract_address` in the existing payload validation, before any purge or warming. Return 400 whose error states that `contract_address` is required to be a string.
- [ ] T004 [AC2] Add the one validation bullet to `docs/webhook.md`.
- [ ] T005 [AC2] Rerun the focused file. Confirm the test file is unchanged since T001.
- [ ] T006 [AC3] Run `CI=true pnpm run test` at the branch head.
- [ ] T007 [AC4] Confirm the diff names only this finding's files and no other `W8-` id.
- [ ] T008 [AC5] Record the ancestry commands and their output under `.postmaster/verify/`. Do not push.
