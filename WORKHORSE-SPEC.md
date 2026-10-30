# Workhorse spec: WEB-1699 [W8-WEBHOOK-006] Fix testing-campaign finding on main (TDD)

## Summary

Reject a webhook event whose `namehash` is not a string or null before any cache purge or warming side effect. A fully shaped unauthenticated-dev event for `red-team.eth` with `namehash: false` must return 400 and must not invalidate caches. Today validation never checks `namehash` when a valid name is also present, so that event returns 200 and runs six internal cache deletes plus batch invalidation.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers (Hono)
- **Dependencies used or added**: none
- **Testing**: focused regression with `pnpm exec vitest run test/webhook.test.ts`; project gate `pnpm run test` (use `CI=true pnpm run test` if vitest would otherwise watch)
- **Constraints**: TDD on the committed main baseline; one finding only (`W8-WEBHOOK-006`); no cherry-pick or transplant from testing-campaign; no other findings.md id; no drive-by refactors

## Direction check

- TDD, regression first, failing run recorded before any product fix: the first product commit on the lane branch adds only the focused regression. Run it on that commit and save the failing transcript before the fix commit.
- Independent fix cut from committed main, not from testing-campaign: implement against this worktree's baseline. Do not read, copy, cherry-pick, or transplant testing-campaign code or tests.
- Only `W8-WEBHOOK-006`: validate the documented primitive shape of `namehash` (`string | null`). Do not add checks for other identity fields (`protocol`, `block_number`, `tx_hash`, `log_index`, `contract_address`, `data`) and do not tighten `namehash` to a 32-byte hex hash. Those are other findings or extra scope.
- Minimal fix, no drive-by refactors: touch only the payload check, the regression, and the webhook doc line that lists enforced validation.
- Documented shape before side effects: the check runs in the existing payload validation path, which already returns 400 before `processWebhookEvent` and before the route wrapper's purge and warming (those run only on a 2xx).

## Structure

- `src/services/webhook.ts` — reject a payload whose `namehash` is not a string or null, before any purge or warming
- `test/webhook.test.ts` — one focused regression for the minimized input
- `docs/webhook.md` — state that `namehash` must be a string or null, in the list of validation the receiver enforces

## Decisions

- `namehash` must be a string or null, including when a valid `name` is also present. `false`, a number, an object, an array, and a missing field are rejected. `null` stays valid. A string stays valid, including the existing short fixture `0x123`; do not require hex length or a `0x` prefix.
- The required regression is the finding's minimized input: a fully shaped unauthenticated-dev event (`allowUnauthenticated: true`, no signature) for `red-team.eth` with `namehash: false`. It asserts HTTP 400, no internal cache deletes, and no batch invalidation. Do not weaken those assertions after the baseline failure is recorded.
- The error response is 400 and identifies `namehash`. The exact sentence is the lane's choice, in the style of the existing validation errors.
- A `namehash` of `null` with a valid name, and a string `namehash` with a valid name, must still be accepted. Add those as non-weakening companions if you want; the focused regression that must fail first is the `false` case.
- Do not open the pull request and do not push. Landing is a pull request from the ticket branch against main, owned outside the lane. The lane's job for that criterion is to leave a self-contained diff with no testing-campaign cherry-picks.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On the commit that adds only the regression, run `pnpm exec vitest run test/webhook.test.ts`. Input is a fully shaped unauthenticated-dev event for `red-team.eth` with `namehash: false`. Save the command, output, and exit under `.postmaster/verify/` before any product-fix commit. | Exit non-zero. The new test fails because the handler returns 200 and performs cache deletes and batch invalidation, not 400 with no invalidation. The transcript exists before the fix commit. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | Same command, same test, after the fix commit. The assertions are still 400, no internal cache deletes, and no batch invalidation. | Exit 0. The focused test passes. Its assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` at the lane HEAD after the fix. If vitest stays in watch mode, stop it and record `CI=true pnpm run test` as well. | Exit 0. |
| AC4 | The change set addresses only `W8-WEBHOOK-006` and does not bundle another findings.md id. | `git diff 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD --stat` and a read of the diff. | Only the `namehash` shape check, its regression, and the webhook doc line for that check. No other finding id, and no new validation of other identity fields. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base HEAD 5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push or open a pull request. | Merge-base is the committed main baseline. Every commit was written in this worktree. No cherry-pick from testing-campaign. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused regression in `test/webhook.test.ts` for a fully shaped unauthenticated-dev event for `red-team.eth` with `namehash: false`, asserting 400, no internal cache deletes, and no batch invalidation. Commit that test alone.
- [ ] T002 [AC1] Run `pnpm exec vitest run test/webhook.test.ts` on the T001 commit. Save the failing transcript under `.postmaster/verify/` before any product-fix commit.
- [ ] T003 [AC2] In `src/services/webhook.ts`, reject a payload whose `namehash` is not a string or null before any purge or warming. Keep `null` and any string accepted. Update the enforced-validation list in `docs/webhook.md` to say `namehash` must be a string or null.
- [ ] T004 [AC2] Re-run `pnpm exec vitest run test/webhook.test.ts`. The same assertions pass.
- [ ] T005 [AC3] Run the project gate `pnpm run test` at the lane HEAD. Exit 0.
- [ ] T006 [AC4] [AC5] Confirm the diff against the main baseline contains only this finding, with no testing-campaign cherry-pick, then write `WORKHORSE-SUMMARY.md`.
