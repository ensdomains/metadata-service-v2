# Workhorse spec: WEB-1713 [W8-BUDGET-002] Fix testing-campaign finding on main (TDD)

## Summary

Add a request-deadline guard (`timeLeftForAttempt`) before `fetchMedia` in `AvatarService.resolveMedia`, extend with per-hop deadline gating via `beforeEachFetch`, budget-bounded signal timeout, causal race against signal-abort event, named listener with exact cleanup, and initial-aborted guard. Enforces invariant B1: no upstream attempt (including the media-host fetch and every redirect hop) starts with less than 1s left; deadline exhaustion always surfaces `RequestDeadlineError`.

## Scope note

This spec was written for the initial one-guard fix and has NOT been rewritten. The actual branch (`WEB-1713` at `928f63e`) spans 15 commits, 11 correction rounds, 3 files, and includes: entry guard, per-hop `beforeEachFetch` gating, `min(7000, remainingRequestTime())` bounded signal, causal `Promise.race` against signal-abort, named handler with `removeEventListener` in `finally`, initial `signal.aborted` guard, and late-rejection suppression. The test file (`test/avatar-deadline.test.ts`) grew through 8 rounds of test-hardening to model full EventTarget semantics with deduplication, capture normalization, invocation-based once auto-removal, stopImmediatePropagation, and post-abort registration behavior — all without any product change since round 6 (`964d536`).

**Prior rewrite**: The test commit at `760ff5c` was rewritten into sibling `4c152cc` via `git commit --amend` to fix a TypeScript compilation error. No review evidence on `760ff5c` is applicable to `4c152cc`.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime, Node.js test runner (vitest)
- **Dependencies**: No new dependencies. Uses existing `timeLeftForAttempt`, `remainingRequestTime` from `src/services/request-budget.ts`; `RequestDeadlineError` from `src/services/errors.ts`.
- **Testing**: `pnpm run test` (vitest). 18 focused tests + 10 direct contract tests in `test/avatar-deadline.test.ts`.
- **Build**: `pnpm run build`
- **Lint**: `pnpm run lint` (0 errors)
- **Typecheck**: `pnpm run typecheck` (clean)

## Structure

- **`src/services/avatar.ts`** (+64/−42): Entry guard, per-hop gating, bounded timeout, causal race, named listener cleanup, initial-aborted guard
- **`test/avatar-deadline.test.ts`** (~450 lines): 18 behavioral tests + 10 contract tests covering all invariants
- **`WORKHORSE-SPEC.md`**: This file (updated for actual scope)

## History

| Round | Date | Commits | Finding |
|---|---|---|---|
| R1 | — | `4deeca1`, `1579f7e` | Entry guard for fetchMedia |
| R2 | — | `59f8c13`, `f06611c` | Per-hop gating, bounded timeout, error conversion |
| R3 | — | `1a3896a`, `27a7536` | deadlineDriven discriminator, body coverage |
| R4 | — | `89b5c8c`, `af9dff5` | signal.aborted attribution guard |
| R5 | — | `78e811f`, `44d5ca0` | Causal race (Promise.race) |
| R6 | — | `2a53b22`, `964d536` | Named handler, exact cleanup, initial-aborted |
| R7 | — | `aa5e7c6` | Identity-sensitive Sets (test only) |
| R8 | — | `953b157` | Tuple-identity (signal,type,cb,capture) (test only) |
| R9 | — | `760ff5c`→`4c152cc` | EventTarget dedup, capture normalization, conditional once (test only) |
| R10 | — | `4c152cc` alone | Abort hook replaced with callback wrapping (test only) |
| R11 | — | `928f63e` | Invocation-based once auto-removal, stopImmediatePropagation, post-abort (test only) |