# Workhorse spec: WEB-1697 [W8-WEBHOOK-004] Fix testing-campaign finding on main (TDD)

## Summary

A fully shaped unauthenticated-dev webhook for `red-team.eth` with `log_index: null` is accepted and purges caches, because payload validation never checks `log_index`. Reject that event with 400 and do no cache invalidation, by runtime-checking that `log_index` is a number before any purge or warming side effect. TDD: a failing regression on main first, then the smallest fix.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers (Hono). No new dependency.
- **Dependencies used or added**: none
- **Testing**: `CI=true pnpm exec vitest run test/webhook-log-index.regression.test.ts` for the focused regression; `CI=true pnpm run test` for the gate. `pnpm run test` is `vitest` in watch mode unless `CI` is set. Do not change `package.json`.
- **Constraints**: one finding, `W8-WEBHOOK-004`, on a branch cut from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. No testing-campaign transplant. No other finding. No drive-by refactor.

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: failing regression first, recorded before any product fix | The first product commit adds only `test/webhook-log-index.regression.test.ts`. The next commit records that run's failure. No change to `src/` before that record exists. |
| Minimal fix after the failing run | The product change rejects a non-number `log_index` before cache deletes, batch invalidation, or warming. |
| Do not copy or cherry-pick testing-campaign | Every line is written fresh. Do not read other branches or `.worktrees/`. |
| One finding only | `log_index` only. Do not add checks for `block_number`, `tx_hash`, `contract_address`, `data`, or `protocol`. |
| No drive-by refactor | No renames, no shared validator extraction, no edits outside the files in Structure. |
| Gate passes at the ticket head | `CI=true pnpm run test` exits 0 after the fix. |
| PR targets main from a ticket-named branch | Workhorses stay on `wb/WEB-1697-<lane>`, do not push, and do not open the PR. The landing branch is `WEB-1697`, already cut from main. |

## Structure

- `test/webhook-log-index.regression.test.ts` — new focused regression at the webhook handler
- `test/webhook-log-index.baseline.txt` — the failing run, committed before the fix, absent from the final tree
- `src/services/webhook.ts` — runtime check only; no other behavior change
- `docs/webhook.md` — the enforced-validation list and the 400 row, so they name `log_index` as a required number

## Decisions

- The interface is not open. The check is `WebhookService.handleWebhook` with `allowUnauthenticated: true` and no signature, the same surface the existing webhook tests and the confirmed finding use. `index.ts` warms only after a 2xx from that handler, so a 400 there is what stops warming.
- Scope is `log_index` only. Other identity fields are other findings. Checking them here fails the "one finding" criterion.
- A `log_index` is valid only when `typeof` is `number`. Do not coerce: `Number(null)` is `0` and must not be accepted. Reject `null`, a missing field, a string, a boolean, an object, and an array. `0` stays valid. Do not add a NaN or Infinity special case; `JSON.parse` does not produce them.
- Rejection is a 400 JSON `{ error: string }` in the existing shape. The string must identify `log_index` and say it must be a number. Exact wording is the lane's choice.
- The regression's minimized input is fixed: event type `NameRegistered`, `protocol: "v2"`, `block_number: 100`, `tx_hash: "0xabc"`, `contract_address: "0xdef"`, `name: "red-team.eth"`, `namehash: "0x123"`, `data: "{}"`, a numeric `timestamp`, and `log_index: null`. Also reject `log_index: "0"` and a missing `log_index`, with no cache side effects. The same event with `log_index: 0` must still be accepted and must still invalidate caches, so a reject-everything change cannot pass.
- No cache invalidation means `cache.delete` is not called, batch `deleteByPrefix` is not called, and metadata, SVG, and storage deletes are not called.
- The baseline transcript is committed at `test/webhook-log-index.baseline.txt` after the test-only commit and before any `src/` or `docs/` change. The fix commit deletes that file. History keeps the record; the shipped tree does not.
- Workhorse branches stay `wb/WEB-1697-<lane>`. Do not rename, push, or open a pull request. Criterion 5 is shown by commits that descend only from BASE with no cherry-pick. The ticket-named branch and the PR are the landing route.
- `CI=true` for every vitest invocation. Do not edit the test script.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds only `test/webhook-log-index.regression.test.ts`, run `CI=true pnpm exec vitest run test/webhook-log-index.regression.test.ts`. Input is the minimized event above: unauthenticated-dev, `name` `red-team.eth`, `log_index: null`, plus the string and missing cases. Commit the command, output and exit to `test/webhook-log-index.baseline.txt` before any product fix commit. | Exit non-zero. The `log_index: null` case fails because the handler returns 200 and cache deletes plus batch invalidation run, not 400 with no invalidation. `git log` shows that transcript commit before any `src/` change. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `CI=true pnpm exec vitest run test/webhook-log-index.regression.test.ts` on the fix commit. Diff the test file against the AC1 commit. | Exit 0. The null case still expects 400, a body that identifies `log_index` and says it must be a number, and no cache, batch, metadata, SVG, or storage deletes. The string and missing cases still expect 400 and no invalidation. The `log_index: 0` case still expects 200 and cache invalidation. No assertion was removed or relaxed. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `CI=true pnpm run test` at the branch head, after the fix. | Exit 0. The suite finishes; it must not be left in watch mode. |
| AC4 | The change set addresses only `W8-WEBHOOK-004` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log -p -- src/ docs/` searched for other finding ids. | Product files are only `test/webhook-log-index.regression.test.ts`, `src/services/webhook.ts`, and `docs/webhook.md`. No other finding id. No check added for any identity field except `log_index`. `WORKHORSE-SPEC.md` and `WORKHORSE-SUMMARY.md` are run records, not another finding. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push. Do not open a PR. Do not rename this branch. | Exit 0. Every commit is a fresh descendant of BASE. No cherry-pick from testing-campaign. The PR from `WEB-1697` onto main is the landing route, not this lane's job. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/webhook-log-index.regression.test.ts` covering the minimized `log_index: null` event for `red-team.eth`, the string and missing cases, and the numeric control. Commit only that file. Run the focused command and confirm it fails because the null event returns 200 and invalidates caches.
- [ ] T002 [AC1] Commit `test/webhook-log-index.baseline.txt` with that command, its output and its exit, before any product change.
- [ ] T003 [AC2] [AC4] In `src/services/webhook.ts`, reject a non-number `log_index` with 400 before any purge or warming side effect. Do not coerce. Do not validate other identity fields. Delete the baseline transcript in this commit.
- [ ] T004 [AC2] [AC4] In `docs/webhook.md`, add `log_index` as a required number to the enforced-validation list and the 400 row. No other doc edit.
- [ ] T005 [AC2] [AC3] Re-run the focused test and `CI=true pnpm run test`. The focused assertions are unchanged and pass.
- [ ] T006 [AC5] Show the branch descends only from BASE, with no cherry-pick, and stop without pushing.
