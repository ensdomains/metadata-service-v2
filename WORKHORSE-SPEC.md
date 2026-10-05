# Workhorse spec: WEB-1715 [W8-BUDGET-003] Fix testing-campaign finding on main (TDD)

## Summary

Fix finding W8-BUDGET-003: the request deadline does not gate CCIP gateway fetches in `guardedCcipRequest`, allowing an attacker-controlled gateway fetch to start and complete after the request deadline is exhausted. The fix adds a `timeLeftForAttempt` check before each gateway fetch attempt, matching the deadline gating already applied to RPC client attempts in `executeWithFallback`.

## Technical context

- **Language and version**: TypeScript (Cloudflare Workers)
- **Dependencies used or added**: None added. Uses existing `timeLeftForAttempt` from `src/services/request-budget.ts`.
- **Testing**: `pnpm run test` (vitest). The new regression test uses vi fake timers and stub fetch to assert `RequestDeadlineError` is thrown before any gateway fetch when the deadline is exhausted.
- **Constraints**:
  - TDD: write failing regression test first, then the minimal fix.
  - One finding only (`W8-BUDGET-003`).
  - Do not touch testing-campaign or copy/cherry-pick from it.
  - Branch cut from main (BASE: `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`).

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: failing test before fix | Commit 1: add regression test to `test/request-deadline.test.ts` that fails on main baseline. Commit 2: minimal fix to `src/services/ccip-request.ts`. |
| One finding only | The change touches only the deadline gating in `guardedCcipRequest`. No other finding, no drive-by refactors. |
| Do not touch testing-campaign | The fix is a fresh implementation from BASE, with no cherry-picks. |
| Branch from main at BASE | The synthesis worktree is at `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` on branch `WEB-1715`. |

## Structure

| File | Action |
|---|---|
| `src/services/ccip-request.ts` | Import `timeLeftForAttempt`; add deadline check before `fetchMediaUrl` in `guardedCcipRequest`; ensure `RequestDeadlineError` propagates. |
| `test/request-deadline.test.ts` | Add regression test: `guardedCcipRequest` throws `RequestDeadlineError` before fetching when <1s remains. |

## Decisions

1. **Where to add the deadline check**: Inside `fetchMediaUrl`'s `beforeEachFetch` callback as a composite `guardedBeforeFetch` that calls `timeLeftForAttempt` before `chargeGatewayFetch`. This gates every actual HTTP fetch — the initial hop AND each redirect hop — before any charge or fetch. The outer one-shot `timeLeftForAttempt` before `fetchMediaUrl` is replaced by this per-hop check (the first hop is also gated by `beforeEachFetch`).
2. **Error propagation**: `RequestDeadlineError` must propagate out of `guardedCcipRequest` uncaught, so the upstream `executeWithFallback` can re-throw it as `UpstreamError`. An explicit `if (err instanceof RequestDeadlineError) throw err` is added in the catch block. A deadline kill terminates the lookup without trying further configured gateways, matching `executeWithFallback`'s behavior.
3. **Deadline-before-charge ordering**: `timeLeftForAttempt` is called before `chargeGatewayFetch` inside `guardedBeforeFetch`, so the deadline check runs before any charge is consumed. At <1000ms remaining, the charge is never taken.
4. **Test placement**: In `test/request-deadline.test.ts`, alongside the existing RPC deadline tests, reusing the `inRequest`, `settle`, `expectDeadlineError` helpers. Tests cover: initial hop at 500ms, redirect hop at 999/1000/1001ms boundaries, relative and absolute redirect targets, configured gateway fallback after redirect deadline kill, deadline-before-charge ordering, and `RequestDeadlineError` taxonomy preservation.
5. **Scope**: Every actual HTTP fetch — initial and each redirect hop — is gated by the request deadline via `beforeEachFetch`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `pnpm run test -- test/request-deadline.test.ts` on the commit that adds only the failing test | The new test fails with `RequestDeadlineError` expected but fetch was called or no error thrown. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `pnpm run test -- test/request-deadline.test.ts` on the commit that adds the fix | All request-deadline tests pass (exit 0), including the new CCIP gateway deadline test. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` on the final commit | Exit 0, all tests pass. |
| AC4 | The change set addresses only `W8-BUDGET-003` and does not bundle another findings.md id. | `git diff BASE...HEAD --stat` on the final branch | Only `src/services/ccip-request.ts` and `test/request-deadline.test.ts` changed. No other finding referenced in commit messages or code. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git log --oneline BASE...HEAD` and `git merge-base HEAD testing-campaign` | All commits are on branch `WEB-1715`; the branch shares no commits with testing-campaign beyond BASE. |

## Tasks

- [ ] T001 [P] [AC1] Add CCIP gateway deadline regression test in `test/request-deadline.test.ts`
- [ ] T002 [P] [AC2] Import `timeLeftForAttempt` and add deadline check before `fetchMediaUrl` in `src/services/ccip-request.ts`
- [ ] T003 [AC3] Run `pnpm run test` to confirm the full gate passes
- [ ] T004 [AC4] [AC5] Verify diff scope: only the two expected files changed, no testing-campaign code