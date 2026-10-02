# Workhorse spec: WEB-1668 [W3-ROUTES-004] Fix testing-campaign finding on main (TDD)

## Summary

When the migration-status endpoint serves a response rescued from stale D1 after a live-tier outage, the response must carry a short `Cache-Control: public, max-age=30` (the error TTL) instead of the normal `Cache-Control: public, max-age=300, stale-while-revalidate=30`. The D1-rescued JSON payload is correct and does not leak provenance; only the cache policy is wrong.

## Technical context

- **Language and version**: TypeScript (strict), Cloudflare Workers runtime, Hono framework
- **Dependencies used or added**: none added; existing vitest test runner, existing hono test harness
- **Testing**: `pnpm run test` (vitest); new focused regression test in `test/` covering the minimized input
- **Constraints**: TDD on main baseline only — write a failing regression test first, record its failure, then fix; do not bundle other findings; do not copy from testing-campaign branch; the fix is a focused change to the migration-status cache-headers logic, not a refactor or a re-architecture

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD on main baseline only — failing regression first, record it, then fix | The spec tasks order the regression test first, with explicit recording of the failing run before any product-code fix |
| One finding only (`W3-ROUTES-004`); independent PR against main | The scope is the migration-status route's cache-headers logic only; no other route or finding is touched |
| Do not copy, cherry-pick, or transplant the audit branch's implementation or tests | The regression test and fix are written fresh against main BASE |
| Do not weaken the regression to pass | The regression asserts `Cache-Control: public, max-age=30` (no stale-while-revalidate) for the D1-fallback response and must fail on the baseline before the fix |
| `pnpm run test` must pass at the ticket branch head | Task T004 runs the gate before the summary |

## Structure

Files created or changed:

- `src/services/metadata.ts` — `getMigrationStatus()`: signal when the response was rescued from D1 after a live-tier failure
- `src/index.ts` — `/migration-status/:name` route handler: apply short cache TTL when the response came from a degraded (D1-fallback) source
- `test/migration-status-cache.test.ts` (new) — focused regression test for the finding

The fix introduces no new exported types and no public API surface change. The migration-status JSON payload shape is unchanged.

## Decisions

1. **Signal mechanism for D1 fallback degradation.** The `getMigrationStatus()` method currently returns a `MigrationStatusResponse` with no signal that the data came from D1 after an upstream failure. The fix adds a private/internal signal — a dedicated property on the return value or a separate return field — that the route handler can read to decide the cache TTL. The signal is stripped before the JSON response is sent, so the public payload is unchanged.

2. **Cache TTL for degraded migration-status responses.** When the response came from D1 (after a live-tier outage), the route handler applies `Cache-Control: public, max-age=30` — the same 30-second error TTL already defined as `CacheTTL.error` in `src/utils/cache-headers.ts`. No stale-while-revalidate is set, matching the existing error-preset behavior.

3. **Scope boundary: this finding only.** The `getMigrationStatus()` change signals D1 fallback for this route only. The equivalent degradation signals for `getMetadata()` (W3-ROUTES-005), `getMigrationStatus()` after non-definitive miss (W3-ROUTES-006), and other routes are separate findings and are not bundled here.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm run test test/migration-status-cache.test.ts` on the baseline (before any product fix). The test sets up mocked services: `FallbackService.getMigrationStatus()` throws `UpstreamError`, `D1Service.getMigrationStatus()` returns a migrated row. It calls the `/migration-status/stale-migration.eth?network=sepolia` route and asserts `Cache-Control: public, max-age=30`. | Test fails because the baseline returns `Cache-Control: public, max-age=300, stale-while-revalidate=30`. The failing output is captured in the run record. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm run test test/migration-status-cache.test.ts` after the fix. Same test, same assertions, no changes to the test. | Test passes. `Cache-Control` header on the response is `public, max-age=30`. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` from the synthesis worktree root | Exit 0, no failing tests |
| AC4 | The change set addresses only `W3-ROUTES-004` and does not bundle another findings.md id. | `git diff BASE...HEAD --stat` | Only the migration-status cache path is touched: `src/services/metadata.ts`, `src/index.ts`, and the new test file. No other route or service is changed. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | Verify the branch name is `WEB-1668` and the diff applies cleanly to main BASE | Branch name `WEB-1668`; `git diff BASE...HEAD` shows only the fix commits; no testing-campaign content appears in the diff |

## Tasks

- [ ] T001 [P] [AC1] Write the focused regression test in `test/migration-status-cache.test.ts`: mock `FallbackService.getMigrationStatus()` to throw `UpstreamError`, mock `D1Service.getMigrationStatus()` to return a migrated row, call `GET /migration-status/stale-migration.eth?network=sepolia`, assert response body is valid JSON with status `migrated`, assert `Cache-Control` header is `public, max-age=30`. Commit this test on its own. Run it and record the failure (it passes on the baseline only if weakened; the expected failure proves the baseline bug).
- [ ] T002 [AC2] [AC4] Implement the fix: in `src/services/metadata.ts`, signal when `getMigrationStatus()` returned data from the D1 catch block. In `src/index.ts`, check that signal in the `/migration-status/:name` route handler and apply `Cache-Control: public, max-age=30` (using `CacheTTL.error`) instead of the normal migration-status preset when the response came from D1. Strip the signal before serializing JSON.
- [ ] T003 [AC2] Run the regression test from T001 against the fix; it must now pass with the same assertions.
- [ ] T004 [P] [AC3] Run `pnpm run test` — the full project gate must pass.