# Workhorse spec: WEB-1712 [W8-BUDGET-001] Fix testing-campaign finding on main (TDD)

## Summary

The request deadline (request-budget.ts) gates every upstream attempt except avatar/header resolver RPC work: `AvatarService.resolveMedia` starts a resolver lookup without checking the deadline, so when the request's time has run out the resolver is still invoked and its null returned as a definitive no-avatar result. Fix by adding a `timeLeftForAttempt` gate in `resolveMedia` before the resolver lookup, matching the discipline already in `blockchain.ts` and `indexer.ts`, so a spent request throws `RequestDeadlineError` before touching the resolver.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime (nodejs_compat)
- **Dependencies used or added**: none added; uses existing `timeLeftForAttempt` from `src/services/request-budget.ts` and `RequestDeadlineError` from `src/services/errors.ts`
- **Testing**: vitest, with `vi.useFakeTimers()` for deadline manipulation — following the pattern in `test/request-deadline.test.ts` and `test/avatar-outage.test.ts`
- **Constraints**: one finding only (W8-BUDGET-001); TDD from committed main BASE `5a5527c7`; no cherry-picks from testing-campaign; do not touch testing-campaign code or tests; independent PR targeting main from a ticket-named branch

## Direction check

| Constraint | How this plan meets it |
|---|---|
| One finding only (W8-BUDGET-001) | The change touches only `src/services/avatar.ts` (`resolveMedia`) and one new test file `test/avatar-request-deadline.test.ts` |
| TDD from main BASE | A focused regression test is written first, committed, and its failing run recorded before any product fix |
| No cherry-picks from testing-campaign | All code is written fresh from BASE; no testing-campaign content is read or copied |
| Independent PR targeting main from ticket-named branch | Branch: `WEB-1712` cut from `5a5527c7`; PR targets `main` |
| Project gate `pnpm run test` passes at ticket branch head | The existing test suite passes before and after the fix |

## Structure

- **`test/avatar-request-deadline.test.ts`** (new): focused regression test — inside `withRequestBudget` with the clock advanced to the deadline, calls `AvatarService.getAvatarImage("budget.eth")` with a resolver seam that records invocation and returns null; asserts `RequestDeadlineError` is thrown and the resolver was never called
- **`src/services/avatar.ts`** (edit): add `timeLeftForAttempt` import and a deadline check in `resolveMedia` before calling `withLegacyFallback`

## Decisions

1. **Import location**: `timeLeftForAttempt` is imported directly from `../services/request-budget` — same pattern as `indexer.ts` and the avatar service's own `import { isOutageStatus, ... }` from sibling services
2. **Gate location**: the deadline check goes in `resolveMedia` after normalization of the name but before `withLegacyFallback`, so both the primary and legacy resolver attempts are gated by one check
3. **Error message**: `"avatar resolution"` or `"header resolution"` — matching the `what` parameter pattern of `timeLeftForAttempt` in blockchain.ts and indexer.ts
4. **No gate in `getAvatarMeta`**: `resolveMetadataRecord` follows a different code path (`lookup` → `withMediaTimeout`) and the finding's scope is `getAvatarImage` / `resolveMedia`; the invariant B1 says "every upstream attempt, including avatar/header resolver RPC work" — adding the gate to `resolveMedia` covers the media (image) path; the metadata path is out of scope for this ticket per the single-finding constraint

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `pnpm run test test/avatar-request-deadline.test.ts` on the commit that adds only the test | Test fails: `RequestDeadlineError` expected but resolver was invoked and returned null (or no error thrown). The failing output is captured. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `pnpm run test test/avatar-request-deadline.test.ts` on the commit with the fix | Test passes: the `RequestDeadlineError` is thrown before the resolver is invoked |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` (full suite) | All tests pass, exit 0 |
| AC4 | The change set addresses only `W8-BUDGET-001` and does not bundle another findings.md id. | `git diff BASE...HEAD` | Only `src/services/avatar.ts` (minor edit) and `test/avatar-request-deadline.test.ts` (new) are changed |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | Verify branch name is `WEB-1712`, base is `5a5527c7`, and no commit references testing-campaign | Branch: `WEB-1712`; base: `5a5527c7`; no cherry-pick commits |

## Tasks

- [ ] T001 [P] [AC1] [AC4] Write `test/avatar-request-deadline.test.ts`: the focused regression test that calls `getAvatarImage` inside `withRequestBudget` with the clock at the deadline and asserts `RequestDeadlineError` is thrown before resolver invocation
- [ ] T002 [AC1] Commit T001 on branch `WEB-1712` and record the failing test run output in `run-log.md`
- [ ] T003 [AC2] [AC4] Edit `src/services/avatar.ts` — add `import { timeLeftForAttempt } from './request-budget'` and insert a `timeLeftForAttempt('avatar resolution')` / `timeLeftForAttempt('header resolution')` gate in `resolveMedia` before `withLegacyFallback`
- [ ] T004 [AC2] [AC3] Run `pnpm run test` (full suite) — verify the regression test passes and all existing tests pass