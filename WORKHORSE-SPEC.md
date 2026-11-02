# Workhorse spec: WEB-1676 [W3-ROUTES-010] Fix testing-campaign finding on main (TDD)

## Summary

Fix the `GET /registry-hierarchy/:name` route so it always returns a 200 with a valid
hierarchy — never a 404 or 503 — when the expiry check passes but the hierarchy service
itself reports absence, outage, or deadline. Replace the error JSON responses with a
root-first zero-owner placeholder hierarchy, using the existing `generateBasicHierarchy`
facility in `MetadataService`.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers (Hono)
- **Dependencies used or added**: None new
- **Testing**: `pnpm run test` (Vitest); new focused route test in `test/` that
  mocks `MetadataService.prototype.getRegistryHierarchy` to throw `NotFoundError`
  (definitive and non-definitive), `UpstreamError`, and `RequestDeadlineError`, and
  asserts 200 with a valid placeholder hierarchy and correct cache headers
- **Constraints**:
  - TDD: regression test must fail on main baseline first, the failure recorded, then
    the fix applied and verified
  - Changes only `src/index.ts` (route handler) and one new test file
  - No cherry-picks or transplants from testing-campaign
  - Must not touch `DomainExpiredError` handling (410 stays)
  - Must not introduce `_provenance` in the placeholder
  - Gate (`pnpm run test`) must pass

## Direction check

| Constraint | How met |
|---|---|
| TDD on main baseline only | Regression test committed first; failure recorded; then fix |
| One finding only | Only the registry-hierarchy route handler changes |
| Independent PR against main | Branch `WEB-1676` cut from `5a5527c7` |
| Do not touch testing-campaign | Fresh implementation against main |
| No weakening the regression | Test assertions match the finding's expected behavior exactly |

## Structure

```
src/index.ts             — modify the registry-hierarchy route handler (lines ~703-738)
test/registry-hierarchy-totality.test.ts  — NEW: focused regression test
WORKHORSE-SPEC.md        — this file
```

## Complexity tracking

None. No departure from the direction.

## Decisions

1. **Placeholder source**: Use `MetadataService.generateBasicHierarchy()`, which already
   produces a root-first zero-owner hierarchy. Currently private; the fix exposes it as a
   public method. The placeholder carries no `_provenance` field (the existing method
   already omits it).

2. **Error-to-response mapping**: In the route handler's catch block, after a successful
   `checkExpiry`:
   - `DomainExpiredError` → unchanged (410 via `httpError`)
   - `NotFoundError` with `definitive: true` → 200 placeholder, normal hierarchy cache headers (`CachePresets.hierarchy`), edge-cached
   - `NotFoundError` with `definitive: false` → 200 placeholder, error cache headers (`CachePresets.error`, 30s), edge-cached
   - `RequestDeadlineError` → 200 placeholder, error cache headers (30s), edge-cached
   - `UpstreamError` (non-deadline) → 200 placeholder, error cache headers (30s), edge-cached
   - Any other error → unchanged (falls through to `httpError`)

3. **`RequestDeadlineError` detection**: Check `instanceof RequestDeadlineError` before
   `instanceof UpstreamError`, since `RequestDeadlineError extends UpstreamError`.

4. **Edge cache**: All placeholder responses are written to the edge cache via
   `edgeCachePut(c, res)` just like the success path, so subsequent requests within the
   TTL window avoid re-calling the hierarchy service.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm run test -- test/registry-hierarchy-totality.test.ts` on the main baseline (before the fix) | Test fails: the route returns 404/503 instead of 200 placeholder. Failure captured in run-log.md. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm run test -- test/registry-hierarchy-totality.test.ts` after the fix | Test passes; all assertions match the finding: 200 status, placeholder hierarchy shape, correct cache headers per error type, no `_provenance`. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` | Exit 0, all existing tests pass, no regressions. |
| AC4 | The change set addresses only `W3-ROUTES-010` and does not bundle another findings.md id. | `git diff 5a5527c7...HEAD --stat` | Only `src/index.ts` (modified) and `test/registry-hierarchy-totality.test.ts` (new). No other files. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | Verify branch is `WEB-1676` cut from `5a5527c7`, commits are original | Branch is `WEB-1676`; all commits authored in this run. |

## Tasks

- [ ] T001 [P] [AC1] Write `test/registry-hierarchy-totality.test.ts`: a focused route test that mocks `MetadataService.prototype.getRegistryHierarchy` to throw `NotFoundError` (definitive and non-definitive), `UpstreamError`, and `RequestDeadlineError`, and asserts 200 with valid placeholder + correct cache headers. Mock `checkExpiry` to succeed.
- [ ] T002 [AC1] Run the regression test on the main baseline and record the failure in the run record.
- [ ] T003 [AC2] [AC3] Modify `src/index.ts` registry-hierarchy catch block to return 200 placeholder for `NotFoundError`/`UpstreamError`/`RequestDeadlineError` with appropriate cache headers.
- [ ] T004 [AC3] Run `pnpm run test` — verify the regression test now passes and all existing tests pass.
- [ ] T005 [P] [AC4] [AC5] Verify diff scope: `git diff 5a5527c7...HEAD --stat` shows only the expected two files.