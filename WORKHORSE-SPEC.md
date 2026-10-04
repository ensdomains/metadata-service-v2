# Workhorse spec: WEB-1712 [W8-BUDGET-001] Fix testing-campaign finding on main (TDD)

## Summary

The request deadline (request-budget.ts) gates every upstream attempt except avatar/header resolver RPC work and metadata lookups: `AvatarService.lookup` invokes `work()` without checking or bounding by the deadline, so when the request's time has run out the resolver is still invoked and its null returned as a definitive no-avatar result. Fix in `lookup()` at the common per-attempt boundary — the single method every resolver invocation passes through — by (a) gating each attempt with `timeLeftForAttempt` and (b) racing work through `raceRequestDeadline` against the returned duration, so a hung resolver is killed by the deadline rather than left to the fixed 8s media timeout. Each individual attempt (primary, legacy fallback for both null and UpstreamError, avatar/header resolution, and metadata resolution) is independently gated and bounded.

*Correction history:*
1. **P1 (outer gate)**: the original approved placement in `resolveMedia` before `withLegacyFallback` was a single outer gate that let legacy fallback attempts start at 999ms after the primary consumed time past the 1000ms floor, and left `getAvatarMeta` unguarded. Two independent reviewers confirmed P1. Corrected in commits `c53d778`→`5628bd3`.
2. **P1 (causal bounding)**: `lookup()` called `timeLeftForAttempt` but discarded the returned duration, using only the fixed 8s media timeout. At exactly 1000ms remaining, a hung resolver stayed pending past the request deadline and settled ~7s later as plain `UpstreamError`. Corrected in commits `0f7cfe3`→`b4d775f`.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime (nodejs_compat)
- **Dependencies used or added**: none added; uses existing `timeLeftForAttempt` and `raceRequestDeadline` from `src/services/request-budget.ts`, `RequestDeadlineError` from `src/services/errors.ts`
- **Testing**: vitest, with `vi.useFakeTimers()` for deadline manipulation — following the pattern in `test/request-deadline.test.ts` and `test/avatar-outage.test.ts`
- **Constraints**: one finding only (W8-BUDGET-001); TDD from committed main BASE `5a5527c7`; no cherry-picks from testing-campaign; do not touch testing-campaign code or tests; independent PR targeting main from a ticket-named branch

## Direction check

| Constraint | How this plan meets it |
|---|---|
| One finding only (W8-BUDGET-001) | Product change: capture `timeLeftForAttempt` return value, wrap `withMediaTimeout` in `raceRequestDeadline`. Import: `raceRequestDeadline` added alongside existing `timeLeftForAttempt`. Test file: `test/avatar-request-deadline.test.ts`. |
| TDD from main BASE | Focused regression tests written first in three TDD cycles, each with committed red test run on the preceding product commit before the fix. |
| No cherry-picks from testing-campaign | All code written fresh from BASE; no testing-campaign content read or copied. |
| Independent PR targeting main from ticket-named branch | Branch: `WEB-1712` cut from `5a5527c7`; PR targets `main`. |
| Project gate passes at ticket branch head | Full suite passes after each fix (1097 passed, 1 skipped at HEAD). |

## Structure

- **`test/avatar-request-deadline.test.ts`** (new): 40 focused regression tests covering avatar, header, and metadata resolution at 0ms, 999ms, 1000ms, and ample remaining; legacy fallback gating; causal deadline bounding (hung work killed by deadline vs media timeout); work completing before both timeouts; exact `RequestDeadlineError` instanceof check; per-attempt independent bounding; name-independent behavior; boundary precision; deletion mutant kill; timer retention after all outcomes (deadline win, media-timeout win, sync/async work success, sync throw, async rejection, primary+legacy).
- **`src/services/avatar.ts`** (edit): import `raceRequestDeadline` and `timeLeftForAttempt` from `./request-budget`; capture `timeLeftForAttempt` return value; track the media-timer handle at the `lookup()` level; create the media timeout inside `runInOutageScope` (preserving outage-scope classification); clear the timer in the outer `finally` block so no timer survives any outcome. `withMediaTimeout` private method also updated with internal timer cleanup for callers that still use it.
- **`WORKHORSE-SPEC.md`** (this file): committed at the planning stage as the record of intent; revised in later commits to document POSTMASTER-HOLD corrections.

## Decisions

1. **Import location**: `raceRequestDeadline` and `timeLeftForAttempt` imported from `./request-budget`.
2. **Gate location**: the deadline check fires in `lookup()` immediately before `work()` is called, gating each individual attempt. Every resolver invocation passes through `lookup()`.
3. **Causal bounding**: `raceRequestDeadline` races the media-timeout promise against a deadline promise with the captured `timeLeft` duration. Whichever is shorter wins: the deadline throws `RequestDeadlineError`, the media timeout throws `UpstreamError`. Outside a request (no budget), `raceRequestDeadline` passes through with no deadline race.
4. **In-scope paths**: `getAvatarImage`, `getHeaderImage`, `getAvatarMeta` — all flow through `lookup()`.
5. **Legacy fallback semantics preserved**: `withLegacyFallback` is unchanged. When the primary attempt consumes time past the floor, the legacy lookup independently throws `RequestDeadlineError`. When the primary hangs, the deadline kills it before legacy is reached.
6. **TDD history**: four red→green cycles — initial gate placement (`62d83dc`→`5d6f4fc`), per-attempt correction (`c53d778`→`5628bd3`), causal deadline bounding (`0f7cfe3`→`b4d775f`), timer cleanup (`fc7db36`→`60e6fa7`).

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `npx vitest run test/avatar-request-deadline.test.ts` on the test-only commit before each fix (commits `62d83dc`, `c53d778`, `0f7cfe3` each tested against the preceding product commit) | Tests fail on the then-current product commit. Failing output captured at dispatch. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `npx vitest run test/avatar-request-deadline.test.ts` on each fix commit | All tests pass: 4/4 after initial, 17/17 after correction, 33/33 after causal bounding, 40/40 after timer cleanup. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `npx vitest run` (full suite) | All tests pass: 59 files, 1104 passed, 1 skipped. |
| AC4 | The change set addresses only `W8-BUDGET-001` and does not bundle another findings.md id. | `git diff BASE...HEAD` | Product change limited to `src/services/avatar.ts`. Test: `test/avatar-request-deadline.test.ts`. Spec: `WORKHORSE-SPEC.md`. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | Verify branch name is `WEB-1712`, base is `5a5527c7`, and no commit references testing-campaign | Pending — branch is `WEB-1712`, base `5a5527c7`, no testing-campaign content. No upstream/PR exists yet; this is a postmaster landing concern. |

## Tasks

- [x] T001 [P] [AC1] [AC4] Write `test/avatar-request-deadline.test.ts`: 33 focused regression tests across three TDD cycles covering gate placement, metadata, legacy fallback, causal deadline bounding, error-type precision, per-attempt independence, and name-independence.
- [x] T002 [AC1] Commit tests on branch `WEB-1712` and record failing test runs on the preceding product commit before each fix.
- [x] T003 [AC2] [AC4] Edit `src/services/avatar.ts`: capture `timeLeftForAttempt` return, wrap `withMediaTimeout` in `raceRequestDeadline(work, timeLeft, what)`; remove stale outer gate from `resolveMedia`.
- [x] T004 [AC2] [AC3] Run `npx vitest run` (full suite): 59 files, 1097 passed, 1 skipped. Typecheck and lint clean.