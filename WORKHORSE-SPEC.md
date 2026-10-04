# Workhorse spec: WEB-1712 [W8-BUDGET-001] Fix testing-campaign finding on main (TDD)

## Summary

The request deadline (request-budget.ts) gates every upstream attempt except avatar/header resolver RPC work and metadata lookups: `AvatarService.lookup` invokes `work()` without checking the deadline, so when the request's time has run out the resolver is still invoked and its null returned as a definitive no-avatar result. Fix by adding a `timeLeftForAttempt` gate in `lookup()` immediately before `work()` — the common per-attempt boundary every resolver invocation passes through — so each individual attempt (primary, legacy fallback for both null and UpstreamError, avatar/header resolution, and metadata resolution) is independently gated. A spent request throws `RequestDeadlineError` before touching the resolver, matching the discipline already in `blockchain.ts` and `indexer.ts`.

*Correction (POSTMASTER-HOLD):* the original approved placement in `resolveMedia` before `withLegacyFallback` was a single outer gate that let legacy fallback attempts start at 999ms after the primary consumed time past the 1000ms floor, and left `getAvatarMeta` unguarded. Two independent reviewers confirmed P1 at that revision. The gate was moved to the correct per-attempt boundary in a follow-on TDD cycle (commits `c53d778` red, `5628bd3` green).

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime (nodejs_compat)
- **Dependencies used or added**: none added; uses existing `timeLeftForAttempt` from `src/services/request-budget.ts` and `RequestDeadlineError` from `src/services/errors.ts`
- **Testing**: vitest, with `vi.useFakeTimers()` for deadline manipulation — following the pattern in `test/request-deadline.test.ts` and `test/avatar-outage.test.ts`
- **Constraints**: one finding only (W8-BUDGET-001); TDD from committed main BASE `5a5527c7`; no cherry-picks from testing-campaign; do not touch testing-campaign code or tests; independent PR targeting main from a ticket-named branch

## Direction check

| Constraint | How this plan meets it |
|---|---|
| One finding only (W8-BUDGET-001) | The product change is 1 line moved: `timeLeftForAttempt(what)` added in `lookup()` (per-attempt), the stale outer `timeLeftForAttempt` in `resolveMedia` removed. Plus 1 import. Test file: `test/avatar-request-deadline.test.ts`. |
| TDD from main BASE | Focused regression tests written first in two TDD cycles (initial + reviewer correction), each with committed red runs recorded before the product fix. |
| No cherry-picks from testing-campaign | All code written fresh from BASE; no testing-campaign content read or copied. |
| Independent PR targeting main from ticket-named branch | Branch: `WEB-1712` cut from `5a5527c7`; PR targets `main`. |
| Project gate `pnpm run test` passes at ticket branch head | Full suite passes at every commit after each fix (1081 passed, 1 skipped). |

## Structure

- **`test/avatar-request-deadline.test.ts`** (new, 305 lines): 17 focused regression tests covering avatar, header, and metadata resolution at 0ms, 999ms, 1000ms, and 10000ms remaining; legacy fallback gating after primary null and UpstreamError consumption; metadata legacy fallback; boundary precision; deletion mutant kill. Uses `withRequestBudget`, `vi.useFakeTimers`, and resolver seams that record invocation and return null.
- **`src/services/avatar.ts`** (edit, net +1 import +1 line): import `timeLeftForAttempt` from `./request-budget`; add `timeLeftForAttempt(what)` in the `lookup()` method immediately before `runInOutageScope(scope, () => this.withMediaTimeout(work(), ...))` — the common per-attempt boundary. Remove the stale outer `timeLeftForAttempt` from `resolveMedia`.
- **`WORKHORSE-SPEC.md`** (this file): committed at the planning stage as the record of intent; revised in a later commit to document the POSTMASTER-HOLD correction.

## Decisions

1. **Import location**: `timeLeftForAttempt` imported from `./request-budget` — same pattern as `indexer.ts` and sibling-service imports in `avatar.ts`.
2. **Gate location (corrected)**: the deadline check fires in `lookup()` immediately before `work()` is called, gating each individual attempt. Every resolver invocation — primary and legacy fallback (null and UpstreamError paths), avatar and header resolution via `resolveRecord`, and metadata resolution via `resolveMetadataRecord` — passes through `lookup()` and is independently checked. The stale outer gate in `resolveMedia` is removed.
3. **In-scope paths**: `getAvatarImage` (avatar), `getHeaderImage` (header), `getAvatarMeta` (metadata) — all flow through `lookup()` and are covered by the single gate.
4. **Legacy fallback semantics preserved**: `withLegacyFallback` is unchanged. When the primary attempt consumes time past the 1000ms floor, the subsequent legacy lookup independently throws `RequestDeadlineError` in `lookup()`, which propagates out of `withLegacyFallback` (the legacy `await` is outside the primary's `try`/`catch`). Both null-return and UpstreamError primary outcomes are covered.
5. **Error message**: the `what` parameter (e.g. `"avatar resolution"`, `"header resolution"`, `"avatar metadata resolution"`) is passed directly to `timeLeftForAttempt`, matching the pattern in `blockchain.ts` and `indexer.ts`.
6. **TDD correction cycle**: the initial fix (`5d6f4fc`) placed the gate in `resolveMedia` before `withLegacyFallback`. Two independent reviewers confirmed this was incorrect (P1): legacy fallback starts at 999ms after primary consumed time, `getAvatarMeta` unguarded. A second TDD cycle expanded the test suite (`c53d778`, 6/17 red) and moved the gate to `lookup()` (`5628bd3`, 17/17 green).

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `npx vitest run test/avatar-request-deadline.test.ts` on the test-only commit (initial `62d83dc`, then expanded `c53d778` with fix stashed) | Tests fail: `RequestDeadlineError` expected but resolver was invoked and returned null (or no error thrown). Failing output captured in dispatch logs. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `npx vitest run test/avatar-request-deadline.test.ts` on the fix commit | Tests pass (4/4 after initial fix, 17/17 after correction): `RequestDeadlineError` thrown before resolver invocation in every path. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `npx vitest run` (full suite) | All tests pass: 59 files, 1081 passed, 1 skipped. |
| AC4 | The change set addresses only `W8-BUDGET-001` and does not bundle another findings.md id. | `git diff BASE...HEAD` | Product change: `src/services/avatar.ts` (+2 lines: 1 import, 1 gate in `lookup()`). Test: `test/avatar-request-deadline.test.ts` (new). Spec: `WORKHORSE-SPEC.md` (record of intent + correction). |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | Verify branch name is `WEB-1712`, base is `5a5527c7`, and no commit references testing-campaign | Branch: `WEB-1712`; base: `5a5527c7`; no cherry-pick commits. |

## Tasks

- [x] T001 [P] [AC1] [AC4] Write `test/avatar-request-deadline.test.ts`: focused regression tests covering avatar, header, metadata, legacy fallback (null and UpstreamError), boundary precision, and deletion mutant kill — 17 tests total across two TDD cycles.
- [x] T002 [AC1] Commit tests on branch `WEB-1712` and record failing test runs (initial: `logs/red-test-run.txt` at `62d83dc`; corrected: `logs/red-test-run-corrected.txt` at `c53d778`).
- [x] T003 [AC2] [AC4] Edit `src/services/avatar.ts`: add `import { timeLeftForAttempt } from './request-budget'`; add `timeLeftForAttempt(what)` in `lookup()` immediately before `runInOutageScope`; remove stale outer `timeLeftForAttempt` from `resolveMedia`.
- [x] T004 [AC2] [AC3] Run `npx vitest run` (full suite): 59 files, 1081 passed, 1 skipped. Typecheck and lint clean.