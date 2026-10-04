# Workhorse spec: WEB-1713 [W8-BUDGET-002] Fix testing-campaign finding on main (TDD)

## Summary

Add a request-deadline guard (`timeLeftForAttempt`) before `fetchMedia` in
`AvatarService.resolveMedia` so the media-host fetch is gated by the same
deadline that gates every other upstream attempt. Currently, the UA-level
record resolution (RPC/gateway) checks the deadline between attempts, but if
that resolution exhausts the time, `fetchMedia` still starts — violating
invariant B1 that no new upstream attempt starts with less than 1s left.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime, Node.js test runner (vitest)
- **Dependencies used or added**: No new dependencies. Uses existing `timeLeftForAttempt` from `src/services/request-budget.ts`.
- **Testing**: `pnpm run test` (vitest). Focused regression test in `test/request-deadline.test.ts` (the existing deadline test file) or a new dedicated test.
- **Constraints**:
  - One finding only (`W8-BUDGET-002`); no other findings.md id bundled.
  - No cherry-picks from testing-campaign.
  - PR targets main from a ticket-named branch.
  - The fix is minimal: one guard at one call site.

## Direction check

| Constraint | How this plan meets it |
|---|---|
| Fix only W8-BUDGET-002 | One guard added in `resolveMedia` before `fetchMedia`; no other changes. |
| TDD from main BASE | Write focused regression test first, record failure, then apply fix. |
| No testing-campaign code | Original implementation; no copy/cherry-pick/transplant. |
| Independent PR from main | Branch `WEB-1713` cut from committed BASE `5a5527c`; one finding. |

## Structure

- **`src/services/avatar.ts`**: Add `timeLeftForAttempt` import from `./request-budget`; insert a call before `this.fetchMedia(uri, kind, name)` at line ~612 in `resolveMedia`.
- **`test/request-deadline.test.ts`** (or new file): Add a focused regression test that sets up `withRequestBudget` with a deadline near exhaustion, resolves a media record, and asserts `RequestDeadlineError` is thrown before `fetchMediaUrl` is called.

## Decisions

1. **Where to place the guard.** The guard goes in `resolveMedia`, immediately before the `this.fetchMedia` call, because that is the site where the UA-level resolution chain (RPC with retry, legacy fallback) has finished and the next upstream attempt is about to start. Placing it inside `fetchMedia` itself would also work but would not change behaviour for any other caller — `resolveMedia` is the only caller.
2. **Test location.** The new test goes in `test/request-deadline.test.ts` to stay with the existing deadline tests that exercise the same invariant (B1). The file already sets up fake timers, mocks `fetch`, and uses `withRequestBudget` / `inRequest` helpers.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `pnpm run test -- test/request-deadline.test.ts` on the branch with only the test commit (before the fix) | The new test fails with the assertion that `RequestDeadlineError` was thrown, but `fetchMediaUrl` was called (or no error was thrown). Output captured as evidence. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `pnpm run test -- test/request-deadline.test.ts` on the branch with both test + fix commits | The new test passes: `RequestDeadlineError` is thrown before `fetchMediaUrl`. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` at branch HEAD | Exit 0, all tests pass including the new one and all existing ones. |
| AC4 | The change set addresses only `W8-BUDGET-002` and does not bundle another findings.md id. | `git diff BASE...HEAD` | Diff touches only `src/services/avatar.ts` (import + guard) and the test file; no other changes. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git log BASE..HEAD` | All commits are original to this branch; no commits or file contents from testing-campaign. |

## Tasks

- [ ] T001 [P] [AC1] Write focused regression test in `test/request-deadline.test.ts`: inside `withRequestBudget` with time set so <1s remains after a mocked record resolution, assert `RequestDeadlineError` before `fetchMediaUrl`.
- [ ] T002 [AC1] Commit the test, run `pnpm run test`, record the failing test output as evidence.
- [ ] T003 [AC2] [AC4] Add `import { timeLeftForAttempt } from './request-budget'` to `src/services/avatar.ts` and insert `timeLeftForAttempt('media fetch')` before `this.fetchMedia(uri, kind, name)` in `resolveMedia`.
- [ ] T004 [AC2] [AC3] Run `pnpm run test`; verify the new test passes and all existing tests pass.
- [ ] T005 [AC5] Verify diff touches only the two files; verify no testing-campaign content in `git log`.