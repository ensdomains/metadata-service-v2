# Workhorse spec: WEB-1671 [W3-ROUTES-006] Fix testing-campaign finding on main (TDD)

## Summary

Fix the migration-status route so that a D1 rescue after a non-definitive live-source miss is
served with degraded cache headers (`Cache-Control: public, max-age=30`) instead of normal
healthy-success headers (`Cache-Control: public, max-age=300, stale-while-revalidate=30`),
matching the pattern already applied to the metadata and registry-hierarchy routes.

## Technical context

- **Language and version**: TypeScript 5.9, Cloudflare Workers (Hono)
- **Dependencies used or added**: None new
- **Testing**: `pnpm run test` (vitest); a new focused unit test validates the degraded response
  path for migration status rescued from D1 after a non-definitive `NotFoundError`
- **Constraints**: TDD on main baseline — write a failing regression test first, record it, then
  fix; do NOT copy or cherry-pick from testing-campaign; the change set addresses only
  W3-ROUTES-006

## Direction check

| Constraint | How met |
|---|---|
| Fix on main baseline only | All work in the `WEB-1671` branch cut from `5a5527c` |
| TDD: regression test fails first | Write a test that exercises the D1 rescue path for migration status, confirm failure, record it |
| One finding only (W3-ROUTES-006) | The diff touches only the migration-status response path; no other finding is addressed |
| No cherry-picks from testing-campaign | The fix and test are written against main, using the same pattern as the metadata/hierarchy fixes (WeakSet or `_provenance`) but with original code |
| `pnpm run test` passes | Gate verified before final commit |
| PR against main | Branch `WEB-1671`, no testing-campaign dependency |

## Structure

Files changed:
- `src/services/metadata.ts` — add `MigrationStatusCacheValue` type, `isDegradedMigrationStatus`
  export, `markDegradedMigrationStatus` helper, and call it from the D1 rescue path in
  `getMigrationStatus`
- `src/index.ts` — update the migration-status route handler to check `isDegradedMigrationStatus`
  and apply `CachePresets.error()` for degraded responses (and short edge-cache TTL)
- `test/` — one new focused test file that exercises the D1 rescue path end-to-end

## Complexity tracking

No departures from the ticket's direction. The fix follows the same pattern the project already
uses for metadata and hierarchy D1 rescues.

## Decisions

1. **Degraded marking mechanism**: Use the same `_provenance` non-enumerable property pattern
   used by the metadata and hierarchy routes (`markDegradedMigrationStatus` via
   `Object.defineProperty`, checked by `isDegradedMigrationStatus`). The project already has
   `CachePresets.error()` (max-age=30) for degraded responses and `edgeCachePut` with a short
   TTL parameter.
2. **Definitive vs non-definitive**: A definitive `NotFoundError` (every tier including the
   primary indexer answered with a clean miss) is genuine absence — D1 rescue either does not
   run or returns a non-degraded response, since a stale D1 row must not overturn evidence of
   absence. A non-definitive miss (primary indexer was skipped or unavailable) means the stored
   answer may be stale and the response must be degraded. This mirrors the existing logic in
   `resolveMetadata`.
3. **Test scope**: The regression test mocks the fallback and D1 services at the `MetadataService`
   level, calls `getMigrationStatus` and then checks `isDegradedMigrationStatus` on the result.
   A second test exercises the route handler to verify the correct `Cache-Control` headers.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit | `pnpm run test -- --run` (focused test only, initially) | Test fails: `isDegradedMigrationStatus` returns `false` for D1-rescued response after non-definitive `NotFoundError` |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior | `pnpm run test -- --run` (same test) | Test passes: `isDegradedMigrationStatus` returns `true`, route returns `Cache-Control: public, max-age=30` |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head | `pnpm run test` in synthesis worktree | All tests pass, exit 0 |
| AC4 | The change set addresses only `W3-ROUTES-006` and does not bundle another findings.md id | Manual review of diff | Diff touches only migration-status degraded-response path |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff | Manual review of commit history | All commits are original, no `cherry-pick` from testing-campaign in log |

## Tasks

- [ ] T001 [P] [AC1] Write a unit test at `test/w3-routes-006.test.ts` that mocks `FallbackService.getMigrationStatus` throwing `NotFoundError({ definitive: false })` and `D1Service.getMigrationStatus` returning a migrated row, calls `MetadataService.getMigrationStatus`, and asserts `isDegradedMigrationStatus` returns `false` (failing on baseline)
- [ ] T002 [AC1] Record the failing test run in the run record
- [ ] T003 [T001] [AC2] Add `MigrationStatusCacheValue` type, `isDegradedMigrationStatus` export, and `markDegradedMigrationStatus` helper to `src/services/metadata.ts`
- [ ] T004 [T003] [AC2] Update the D1 rescue catch block in `getMigrationStatus` to call `markDegradedMigrationStatus` when the error is not a definitive `NotFoundError`
- [ ] T005 [T003] [AC2] Update the migration-status route handler in `src/index.ts` to check `isDegradedMigrationStatus` and use `CachePresets.error()` with short `edgeCachePut` TTL for degraded responses
- [ ] T006 [T004] [T005] [AC2] Rerun the regression test and confirm it passes without weakening the assertion
- [ ] T007 [AC3] Run `pnpm run test` and ensure all tests pass
- [ ] T008 [AC4] Review the diff to confirm only W3-ROUTES-006 changes are present