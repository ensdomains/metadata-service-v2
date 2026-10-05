# Workhorse spec: WEB-1715 [W8-BUDGET-003] Fix testing-campaign finding on main (TDD)

## Summary

Fix finding W8-BUDGET-003: the request deadline does not gate CCIP gateway fetches in `guardedCcipRequest`, allowing an attacker-controlled gateway fetch to start and complete after the request deadline is exhausted. The fix adds a `timeLeftForAttempt` check before each gateway fetch attempt, matching the deadline gating already applied to RPC client attempts in `executeWithFallback`.

## Technical context

- **Language and version**: TypeScript (Cloudflare Workers)
- **Dependencies used or added**: None added. Uses existing `timeLeftForAttempt` from `src/services/request-budget.ts`.
- **Testing**: `pnpm exec vitest run` (vitest). The new regression tests use vi fake timers and stub fetch to assert `RequestDeadlineError` is thrown before any gateway fetch (initial or redirect) when the deadline is exhausted.
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
| `src/services/ccip-request.ts` | Import `RequestDeadlineError`; add composite `guardedBeforeFetch` callback passed to `fetchMediaUrl`'s `beforeEachFetch` — calls `timeLeftForAttempt` before `chargeGatewayFetch` for every HTTP hop; add `RequestDeadlineError` rethrow in catch block. |
| `test/request-deadline.test.ts` | Add 10 focused regression tests covering initial hop, redirect hops at 999/1000/1001ms boundaries, relative/absolute redirect targets, configured-gateway fallback, deadline-before-charge ordering, and `RequestDeadlineError` taxonomy. Test-hardening commit `e99ccfb` adds `toBeInstanceOf(RequestDeadlineError)` assertion that kills a prototype mutant (plain `UpstreamError` with name `RequestDeadlineError`). |
| `WORKHORSE-SPEC.md` | This spec (docs only). |

## Decisions

1. **Where to add the deadline check**: Inside `fetchMediaUrl`'s `beforeEachFetch` callback as a composite `guardedBeforeFetch` that calls `timeLeftForAttempt` before `chargeGatewayFetch`. This gates every actual HTTP fetch — the initial hop AND each redirect hop — before any charge or fetch. The outer one-shot `timeLeftForAttempt` before `fetchMediaUrl` is replaced by this per-hop check (the first hop is also gated by `beforeEachFetch`).
2. **Error propagation**: `RequestDeadlineError` must propagate out of `guardedCcipRequest` uncaught, so the upstream `executeWithFallback` can re-throw it as `UpstreamError`. An explicit `if (err instanceof RequestDeadlineError) throw err` is added in the catch block. A deadline kill terminates the lookup without trying further configured gateways, matching `executeWithFallback`'s behavior.
3. **Deadline-before-charge ordering**: `timeLeftForAttempt` is called before `chargeGatewayFetch` inside `guardedBeforeFetch`, so the deadline check runs before any charge is consumed. At <1000ms remaining, the charge is never taken.
4. **Test placement**: In `test/request-deadline.test.ts`, alongside the existing RPC deadline tests, reusing the `inRequest`, `settle`, `expectDeadlineError` helpers. Tests cover: initial hop at 500ms, redirect hop at 999/1000/1001ms boundaries, relative and absolute redirect targets, configured gateway fallback after redirect deadline kill, deadline-before-charge ordering, and `RequestDeadlineError` taxonomy preservation.
5. **Scope**: Every actual HTTP fetch — initial and each redirect hop — is gated by the request deadline via `beforeEachFetch`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `pnpm exec vitest run test/request-deadline.test.ts` on RED commit `e0c0769` at HEAD `80f8ba3` | 7 tests fail with `expected undefined to be an instance of UpstreamError` — redirect hops succeed without deadline check. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `pnpm exec vitest run test/request-deadline.test.ts` on GREEN commit `b1bdbf3` | 49/49 pass (exit 0), including all 10 CCIP gateway deadline tests. |
| AC3 | The project gate passes at the ticket branch implementation/test-hardening head. | `pnpm exec vitest run` at `e99ccfb` (docs-only corrections follow) | 58 files, 1074 passed, 1 skipped, exit 0. |
| AC4 | The change set addresses only `W8-BUDGET-003` and does not bundle another findings.md id. | `git diff --stat BASE...HEAD` | 3 files: `WORKHORSE-SPEC.md` (+63), `src/services/ccip-request.ts` (+23 -3), `test/request-deadline.test.ts` (+459 -2), total +545/-5. No other finding in commits or code. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base HEAD testing-campaign` | `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` (BASE — zero commit overlap). |

## Tasks

- [x] T001 [P] [AC1] Add CCIP gateway deadline regression tests in `test/request-deadline.test.ts` (10 initial-hop/redirect tests, RED commit `e0c0769`: 7 intended failures on HEAD `80f8ba3`)
- [x] T002 [P] [AC2] Per-hop admission gating: `guardedBeforeFetch` composite callback + `RequestDeadlineError` rethrow (GREEN commit `b1bdbf3`)
- [x] T003 [P] [AC2] Fetch-signal bounding: combined `AbortSignal.any([ccipSignal, deadlineSignal])` bounded by remaining deadline; `remainingRequestTime()===0` → `RequestDeadlineError` in catch (RED commit `c5f4978`: 6 intended failures on HEAD `49ead70`; GREEN commit `64358b1`)
- [x] T004 Test hardening `e99ccfb`: `toBeInstanceOf(RequestDeadlineError)` assertion; kills `UpstreamError`-with-name mutant
- [x] T005 [AC3] `pnpm exec vitest run` — 58 files, 1083 passed, 1 skipped; typecheck/lint/build all pass
- [x] T006 [AC4] [AC5] 3 files (+548 -5) at HEAD `d20fc9f`: `WORKHORSE-SPEC.md` (+63), `src/services/ccip-request.ts` (+24 -3), `test/request-deadline.test.ts` (+461 -2); merge-base with testing-campaign = BASE
- [x] T007 Test hardening `e99ccfb`: `toBeInstanceOf(RequestDeadlineError)` prototype assertion; kills `UpstreamError`-with-name mutant
- [x] T008 Test hardening `f00714f`: hardened 3 signal-bounding tests with mutant kills (reset-per-hop, 9s-timeout, active-fetch-retention); all 58/58 pass
- [x] T009 Test hardening `0cccb01`: `Promise.allSettled` with per-result `RequestDeadlineError` checks; kills no-signal mutant (32 hang → results.length 0); bounded-settlement proof via fake timers
- [x] T010 Test hardening `d20fc9f`: elapsed ≤2050ms assertion; kills fixed-8s mutant (all 32 settle but elapsed ~8000ms > 2050)