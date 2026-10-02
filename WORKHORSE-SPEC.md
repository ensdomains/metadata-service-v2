# Workhorse spec: WEB-1670 [W3-ROUTES-005] Fix testing-campaign finding on main (TDD)

## Summary

When metadata is rescued from D1 after a non-definitive live miss (the primary indexer was skipped or unavailable), the response is degraded and must not be published as normal success. The fix must propagate a "degraded" provenance signal through the call chain so the metadata cache and route handler can apply short-lived `Cache-Control: public, max-age=30` and avoid writing a long-lived KV entry.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime (workerd)
- **Dependencies used or added**: none new; vitest for testing
- **Testing**: `pnpm run test` (vitest); route-level integration tests using Hono's `app.request()`
- **Constraints**: TDD — write a failing regression test on the main baseline first, record the failure, then implement the minimal fix. Do not copy from testing-campaign. One finding only. Independent PR against main. The fix must not leak provenance in the public response body.

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: write failing regression first, then fix | AC1/AC2 tests written before any product code change |
| Do not copy from testing-campaign | Implementation derived from reading main code, not audit branch |
| One finding only (W3-ROUTES-005) | Change set scoped to the degraded-provenance signal path |
| Independent PR against main | Branch `WEB-1670` cut from main BASE `5a5527c7` |
| No leaked provenance in public response | Degraded signal stays internal (call chain only); response body unchanged |

## Structure

Files changed:

- `src/services/metadata.ts` — `getMetadata()` returns a signal alongside metadata indicating whether the response came from D1 fallback (degraded provenance). Implementations: add a `degradedProvenance` boolean inside a wrapper return type, or return it alongside `MetadataResponse`.
- `src/services/metadata-cache.ts` — `MetadataCacheResult` gains a `degraded` field. `get()` passes the degraded signal through from the origin fetch. When degraded, the KV write uses a short expiration TTL (≤ 30s) or is skipped entirely.
- `src/index.ts` — `handleMetadata()` checks the degraded flag. When true, sets `Cache-Control: public, max-age=30` and caps the edge cache at 30s instead of the per-migration-status TTL.
- `test/` — new regression test file (e.g. `test/degraded-provenance.test.ts`) that demonstrates the failure before the fix and passes after.

## Decisions

1. **How to signal degraded provenance internally.** Use a new field on `MetadataCacheResult` (`degraded: boolean`), set by `MetadataCacheService.get()` based on a signal from `MetadataService.getMetadata()`. The signal from `getMetadata()` is an additional return field (e.g. wrapping `MetadataResponse` with `{ metadata, provenance: 'live' | 'degraded-d1' }`). This keeps the public `MetadataResponse` type unchanged (no provenance leak) while allowing downstream code to adjust caching behavior. *Alternative rejected: throwing a custom DegradedError would disrupt existing error-handling paths; modifying MetadataResponse with an internal field risks accidental serialization in JSON responses.*

2. **What TTL to use for degraded responses.** `max-age=30` as specified in the finding. The edge cache cap is also 30s. The KV write is skipped entirely (not even a short TTL write), since the degraded data is a last-resort rescue and must not persist beyond a single request's edge lifetime. *Alternative rejected: a short KV TTL of 30s would still persist the degraded entry beyond the edge cache window and could serve degraded data past the client's 30s window if the edge cache is cold.*

3. **How the metadata cache knows provenance is degraded.** `MetadataService.getMetadata()` returns a struct with both the metadata and a provenance field instead of bare `MetadataResponse`. When the D1 rescue path is taken, provenance is `'degraded-d1'`. `MetadataCacheService.get()` reads this provenance and sets `degraded: true` on the result, and skips the KV write. *Alternative rejected: checking `metadata.attributes` for a special marker — fragile, couples cache logic to attribute structure, and risks leaking the marker.*

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm run test -- --run test/degraded-provenance.test.ts` on the unmodified main baseline (before any fix commit). | Test fails: the route returns `Cache-Control` with the normal TTL (e.g. `max-age=3600`) instead of `max-age=30`, the edge cache stores with 300s max-age, and/or the KV write has `expirationTtl: 604800` instead of no write or ≤ 30s. The failing output is recorded in `.postmaster/verify/`. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `pnpm run test -- --run test/degraded-provenance.test.ts` on the fixed branch. | Test passes: all assertions on Cache-Control, edge cache TTL, and KV write behavior hold. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` at the synthesis worktree root. | Exit 0; all tests pass. |
| AC4 | The change set addresses only `W3-ROUTES-005` and does not bundle another findings.md id. | `git diff BASE...HEAD --stat` and review. | Only files listed in Structure are changed; no other finding's code is touched. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | Verify branch name is `WEB-1670`, base is `main`, diff is self-contained. | Branch `WEB-1670` based on main BASE `5a5527c7`; diff stands alone without testing-campaign ancestry. |

## Tasks

- [ ] T001 [P] [AC1] Write `test/degraded-provenance.test.ts` — a focused regression test that mocks `FallbackService.getDomainMetadata()` throwing `NotFoundError({ definitive: false })`, stubs `D1Service.getDomain()` returning a row, calls the metadata route, and asserts: (a) HTTP 200 with correct public metadata body, (b) `Cache-Control: public, max-age=30` on the response, (c) the edge cache entry has `max-age ≤ 30`, (d) no KV write with `expirationTtl > 30` occurred.
- [ ] T002 [P] [AC1] Run the regression test against the main baseline, record the failure output under `.postmaster/verify/regression-fail.txt`.
- [ ] T003 [AC2] Add a provenance signal to `MetadataService.getMetadata()` return value (e.g. `{ metadata: MetadataResponse, provenance: 'live' | 'degraded-d1' }`), setting `'degraded-d1'` when D1 rescue is used.
- [ ] T004 [AC2] Add `degraded` field to `MetadataCacheResult`; in `MetadataCacheService.get()`, propagate the degraded signal from the origin and skip KV write when degraded.
- [ ] T005 [AC2] In `handleMetadata()` in `src/index.ts`, when the result is degraded, set `Cache-Control: public, max-age=30` and cap `edgeCachePut` at 30s.
- [ ] T006 [AC2] Run the regression test against the fixed branch; confirm it passes. Record the passing output under `.postmaster/verify/regression-pass.txt`.
- [ ] T007 [AC3] Run `pnpm run test`; confirm all tests pass.
- [ ] T008 [AC4] Review `git diff BASE...HEAD`; confirm only the files in Structure are changed and no other finding is addressed.