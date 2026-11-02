# Workhorse spec: WEB-1700 [W8-WEBHOOK-007] Fix testing-campaign finding on main (TDD)

## Summary

Reject a webhook whose documented flat-event fields are not the documented types — opaque `data` must be a string — with HTTP 400 and no cache purge or warming, proven by a regression that fails on main before the fix.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, tested with Vitest 2 under Node (`pnpm run test` is `vitest`).
- **Dependencies used or added**: none. Do not add a validation library.
- **Testing**: focused one-shot `pnpm exec vitest run test/webhook-wire-shape.test.ts`; the recorded gate is `pnpm run test`, run through the run's `verify.sh`, not by renaming the script.
- **Constraints**: TDD on committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` only. One finding, `W8-WEBHOOK-007`. No cherry-pick, copy, or transplant from `testing-campaign`. No drive-by refactor. The lane does not push and does not open the pull request.

## Direction check

- **Failing regression first, recorded before any product fix.** The lane's first commit after this spec is the new test only. The failing run is saved, including that commit's hash, before the fix commit. Met by T001 and T002.
- **Then the minimal fix, then the same test, then the gate.** Met by T003–T005. The assertions that encode "400 and no cache invalidation" are not edited after the failing commit.
- **Do not copy or cherry-pick `testing-campaign`.** Implement from this spec and the main baseline only. Do not read other branches, `.worktrees/`, or the primary checkout (it is on `testing-campaign` and is not yours to touch).
- **One finding only.** The diff addresses `W8-WEBHOOK-007` and names no other findings id. No unrelated cleanup.
- **Independent pull request from a ticket-named branch onto main.** The lane stays on its workhorse branch cut from main. The ticket branch `WEB-1700` and the pull request are the run's landing, not the lane's to open.
- **Project rules.** There is no `AGENTS.md`. Follow `README.md`, `docs/webhook.md`, and the existing webhook tests. `docs/webhook.md` names `src/services/webhook.ts` as the source of truth for validation. Do not change auth, body-size, signature, or warming architecture.

## Structure

- `test/webhook-wire-shape.test.ts` — new focused regression. Create it. Do not refactor `test/webhook.test.ts` or `test/webhook-warming.test.ts`.
- `src/services/webhook.ts` — the only product file the fix must change.
- `docs/webhook.md` — optional, and only to make the "Validation enforced" list match the types this finding requires. No other doc edit.

## Complexity tracking

None. No departure from the ticket direction.

## Decisions

- **Where the regression runs.** Drive `WebhookService.handleWebhook` with the local-dev unauthenticated config (`requireAuth: false` and `allowUnauthenticated: true`), the same shape of cache fakes the existing webhook tests use. That is the path the finding names: an unauthenticated-dev event is accepted today and then six internal cache deletes plus batch invalidation run. Do not use the fail-closed no-secret config; that returns 503 before payload validation and hides the bug. Do not require a signature for this regression. The route wrapper in `src/index.ts` purges and warms only after a 2xx from the service, so a 400 from `handleWebhook` is what stops those side effects. Do not restructure the route.
- **The minimized input, exactly.** A fully shaped event for `red-team.eth`: every documented field present and valid, except `data` is JSON boolean `false` (not the string `"false"`, not omitted). `event_type` is a non-empty string such as `NameRegistered`, `protocol` is `v2`, `name` is `red-team.eth`, `namehash` is a string, `block_number` and `log_index` are numbers, `tx_hash` and `contract_address` are strings, `timestamp` is a number.
- **What 400 must prevent.** Status 400, and no cache invalidation. The test must observe that the internal cache deletes and the batch invalidation the finding names did not run, and that the service's other purge writes (metadata KV deletes, SVG KV deletes, storage prefix deletes) did not run either. Returning 200 and skipping deletes is not a fix. The error JSON may follow the existing `{ error: string }` shape; the assertions that must not be weakened are the status and the no-invalidation checks, not the error string.
- **`data` stays opaque.** It must be a string, including `""`, `"{}"`, and a non-JSON string. Do not parse it. `false`, `null`, a number, an object, an array, and a missing `data` are rejected with 400 before any purge. The mandatory regression is `data: false`; other non-string cases may be additional tests in the same file and must not replace that case.
- **Every documented wire field is type-checked before side effects.** The contract in `src/services/webhook.ts` is the documented flat shape. Before any purge or warming side effect, require:
  - `event_type`: non-empty string (already enforced; do not add a PascalCase rule — any other non-empty string is accepted today)
  - `protocol`: `"v1"` or `"v2"`
  - `block_number`: number
  - `tx_hash`: string (empty is allowed; do not require a `0x` hash)
  - `log_index`: number
  - `contract_address`: string (empty is allowed)
  - `name`: string or null; if it is a string within the existing length and depth limits, the existing ENS-name check still applies; a name over those limits is still acknowledged, not rejected
  - `namehash`: string or null
  - `data`: string, required, not parsed
  - `timestamp`: number (already enforced)
  - name or namehash still must be present (already enforced)
  - unknown extra fields are still accepted
- **Do not tighten anything else.** No change to signature, timestamp skew, IP allowlist, body cap, event-type set, which caches a valid event invalidates, or the route's purge/warm path.
- **How the failing run is recorded.** Commit the new test alone. Run the focused command. Save the command, the output, the exit, and `git rev-parse HEAD` to `.postmaster/verify/ac1-baseline-fail.txt` before any product fix commit. That HEAD must be the test-only commit. The failure must be the baseline accepting `data: false` and invalidating caches, not a broken test. Then fix. The later pass is `.postmaster/verify/ac2-focused-pass.txt`. A diff of the test file from the failing commit to the final commit must show the 400 assertion and the no-invalidation assertions unchanged.
- **Landing is not the lane's.** Do not push. Do not open a pull request. Do not cherry-pick. AC5 is shown by the branch containing main's BASE as an ancestor and by the absence of cherry-pick trailers. The pull request from `WEB-1700` to main is opened after this lane, by the run's landing, not by the lane.
- **No browser.** No acceptance criterion touches a user-facing browser surface. There is no browser suite and no User journey. Do not attempt a browser walk.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On the test-only commit, before any product fix commit: `pnpm exec vitest run test/webhook-wire-shape.test.ts`. The test posts a fully shaped unauthenticated-dev event for `red-team.eth` with `data: false` through `WebhookService.handleWebhook`. Save the command, output, exit, and `git rev-parse HEAD` to `.postmaster/verify/ac1-baseline-fail.txt`. | Non-zero exit. The failure is that this event is accepted (200) and cache invalidation runs (internal cache deletes and batch invalidation), not that the test failed to load. The saved HEAD is the test-only commit and is an ancestor of every later commit. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | At the fix head: `pnpm exec vitest run test/webhook-wire-shape.test.ts`. Save command, output, and exit to `.postmaster/verify/ac2-focused-pass.txt`. Then `git diff <ac1-commit> -- test/webhook-wire-shape.test.ts`, saved to `.postmaster/verify/ac2-assertion-diff.txt`. | Focused command exits 0. The diff shows the 400 assertion and the no-cache-invalidation assertions unchanged from the failing commit. A string `data` value is still accepted. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test`, and the run's checks via `verify.sh run .` (the pinned tool path in the brief), at the lane's branch head. Save the output under `.postmaster/verify/`. The ticket branch `WEB-1700` is gated by the coachman after synthesis; the lane gates its own head, which is the implementation the synthesis is drawn from. | Exit 0. `verify.sh` reports the gate and the library check passed. If `vitest` would watch because stdin is a TTY, set `CI=true` in the environment and still invoke `pnpm run test`; a watch that does not exit is not a pass. |
| AC4 | The change set addresses only `W8-WEBHOOK-007` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`, saved under `.postmaster/verify/`. Do not open another checkout's findings file. | Diff is only `test/webhook-wire-shape.test.ts`, `src/services/webhook.ts`, and optionally the validation list in `docs/webhook.md`. No other `W8-` id appears in the diff or commit subjects. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push. Do not run `git cherry-pick`. Do not open a pull request. | Ancestor check exits 0. No commit message contains a cherry-pick trailer. No remote was updated. The pull request from ticket branch `WEB-1700` to main is the run's landing, not this command. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/webhook-wire-shape.test.ts`. One test sends the fully shaped unauthenticated-dev event for `red-team.eth` with `data: false` and asserts HTTP 400 and no cache invalidation (no internal cache deletes, no batch invalidation, no metadata, SVG, or storage purges). Separate tests may show that string `data` is still accepted and that other mistyped documented fields are rejected. Commit this file alone. Do not change product code in this commit.
- [ ] T002 [AC1] Run `pnpm exec vitest run test/webhook-wire-shape.test.ts` on that commit. Record the command, output, exit, and HEAD in `.postmaster/verify/ac1-baseline-fail.txt` before any product fix commit. The run must fail because the baseline accepts the event and invalidates caches.
- [ ] T003 [AC2] In `src/services/webhook.ts` only, reject a payload whose documented wire fields do not match the type table in Decisions, before any purge or warming side effect. Do not parse `data`. Do not change auth, the body cap, or the route.
- [ ] T004 [AC2] Re-run the focused test. It must pass. Confirm the 400 and no-invalidation assertions are unchanged from the T001 commit. Record `.postmaster/verify/ac2-focused-pass.txt` and `.postmaster/verify/ac2-assertion-diff.txt`.
- [ ] T005 [AC3] Run `pnpm run test` and `<tool>/scripts/verify.sh run .` at the branch head. Both must exit 0.
- [ ] T006 [AC4] Confirm the diff against BASE names only this finding and touches only the files in Structure.
- [ ] T007 [AC5] Confirm BASE is an ancestor, no cherry-pick was used, and nothing was pushed. Do not open a pull request.
