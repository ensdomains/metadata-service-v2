# Workhorse spec: WEB-1666 [W3-ROUTES-002] Fix testing-campaign finding on main (TDD)

## Summary

Metadata rescued from stale D1 after a live-tier outage must still be returned, but it must not be published as a normal long-lived success. Add a focused route regression that fails on main in the way finding `W3-ROUTES-002` describes, record that failure, then make the smallest product change that meets the finding's expected cache behavior.

## Technical context

- **Language and version**: TypeScript on Node, Cloudflare Worker runtime types, as the repo already uses.
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile`.
- **Testing**: `NO_COLOR=1 pnpm exec vitest run test/w3-routes-002.test.ts` for the focused regression; `pnpm run test` for the project gate. The run's checks are that gate and `/Users/davidchu/projects/brindlewick/postmaster/scripts/verify-library.sh`.
- **Constraints**: TDD on a branch cut from main at `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Do not touch the primary checkout, and do not copy, cherry-pick, or transplant the testing-campaign implementation or its tests. One finding only.

## Direction check

- **Failing regression before any product fix.** The first product commit on the lane branch, after the spec if it is already committed, is the regression only. Run it on that baseline and keep the failing transcript before any fix commit.
- **Do not weaken the regression.** The assertions of the finding's expected behavior stay as written. A later edit that accepts the old headers, the old edge TTL, or a long ordinary KV TTL fails the ticket.
- **Rewrite against main.** The audit checkout is read-only input for the finding text. It is not a patch source.
- **One finding.** Do not bundle another `findings.md` id, including `W3-ROUTES-001` and `W3-ROUTES-003` through `W3-ROUTES-007`. Do not change migration-status, hierarchy, image, rasterize, or avatar caching to fix this.
- **Healthy success stays long-lived.** PLAN C4's normal metadata TTLs (native/migrated 24h/30d, unmigrated 1h/7d) still apply to a live-tier hit. This ticket changes only the stale-D1 rescue after a live-tier outage.
- **Degraded responses are not healthy cache entries.** The waybill's risk surface says an outage rescue must not be cached as a healthy success. The edge cap of 300s in the README is the healthy-metadata edge cap, not the cap for this rescue.
- **No drive-by refactors.** Do not restyle unrelated cache helpers, and do not add a dependency.
- **Landing.** The postmaster opens the pull request against main from the ticket branch. A lane does not push or open a pull request.

## Structure

- `test/w3-routes-002.test.ts` — the focused regression. Create it.
- The product change is wherever the lane keeps the rescue from being published as a normal success. Likely touch points, not a required design: `src/index.ts` (client and edge `Cache-Control` on the metadata route), `src/services/metadata.ts` (the stale-D1 rescue), `src/services/metadata-cache.ts` (ordinary KV write). Change only what this finding needs.

## Decisions

- **Rescue remains a 200.** `GET /sepolia/registry/stale-route.eth` with `FallbackService.getDomainMetadata()` throwing `UpstreamError` and `D1Service.getDomain()` returning a row still returns the D1-derived public metadata, status 200. Stale data beats a 503. The defect is publishing that rescue as a normal long-lived success, not the rescue itself.
- **Literal short cache headers.** Client and captured edge `Cache-Control` are exactly `public, max-age=30`. No `stale-while-revalidate`. That is the existing error TTL (`CacheTTL.error`), used here because the body is rescued after an outage.
- **No ordinary long-lived KV entry.** Do not write the ordinary metadata KV entry (`meta:{network}:{registryType}:{canonical name}`, the shape a healthy miss writes) with `expirationTtl` greater than 30. The confirming failure stored that shape for 604800 seconds; native/migrated would be 2592000. Omitting the KV write satisfies this. An explicitly degraded representation that is not that ordinary long-lived entry is permitted. A public `_provenance` field is not required and is not part of this finding.
- **Baseline failure shape.** The D1 row in the regression has no migration-status row, so main classifies the rescue as unmigrated and fails as the confirming run did: client `public, max-age=3600, stale-while-revalidate=601200`, edge `public, max-age=300`, ordinary KV `expirationTtl` 604800. Assert the expected behavior, not those wrong numbers.
- **Isolate the named inputs.** Stub `MetadataService.checkExpiry` so it resolves. The expiry gate is not this finding; a live RPC must not 410 or mask the rescue. Do not stub `getMetadata`. The route must run the real metadata service, which calls the stubbed `FallbackService.getDomainMetadata` and `D1Service.getDomain`.
- **Edge entry is required.** The expected behavior is an edge store of `public, max-age=30`, not the absence of an edge entry. Skipping `caches.default.put` does not pass.
- **Rate limit.** Set `RATE_LIMIT_DISABLED=true` in the test env so the limiter's own KV counter is not confused with the metadata entry.
- **Pull request.** Lanes do not open it. The synthesis branch is `WEB-1666`, already cut from main. A lane's branch stays `wb/WEB-1666-<lane>`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | On a branch cut from `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`, with only the regression added, run `NO_COLOR=1 pnpm exec vitest run test/w3-routes-002.test.ts`. Input inside that test: `GET /sepolia/registry/stale-route.eth`, `FallbackService.getDomainMetadata()` rejects with `UpstreamError`, `D1Service.getDomain()` returns a `stale-route.eth` row and no migration-status row, `checkExpiry` resolves. Save the command, output, and exit under `.postmaster/verify/` before any product-fix commit. | Exit 1. The failure shows the finding's actual publication: client `Cache-Control` is `public, max-age=3600, stale-while-revalidate=601200` rather than `public, max-age=30`, the edge entry is `public, max-age=300` rather than `public, max-age=30`, and the ordinary metadata KV put uses `expirationTtl` 604800. The transcript exists before the fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | `NO_COLOR=1 pnpm exec vitest run test/w3-routes-002.test.ts` on the final code. Compare the test with the failing commit: `git diff <failing-regression-commit> -- test/w3-routes-002.test.ts`. | Exit 0. The test still expects status 200, body `name` `stale-route.eth`, client and captured edge `Cache-Control` exactly `public, max-age=30`, and no ordinary `meta:sepolia:registry:stale-route.eth` KV put with `expirationTtl` greater than 30. The diff does not relax those assertions. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` at the lane HEAD, after the fix. | Exit 0. |
| AC4 | The change set addresses only `W3-ROUTES-002` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and a search of the diff for other finding ids (`W3-ROUTES-001`, `W3-ROUTES-003`, `W3-ROUTES-004`, `W3-ROUTES-005`, `W3-ROUTES-006`, `W3-ROUTES-007`, `W3-NAMES-`, `CACHE-001`, `FALLBACK-`). | The diff is the regression plus the minimal rescue-cache fix. No other finding id appears as a bundled behavior change. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push or open a pull request. | The ancestor check exits 0. The log has no testing-campaign cherry-pick. Opening the pull request from `WEB-1666` against main is the postmaster's landing step, so that part is `not shown` on a lane. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/w3-routes-002.test.ts` for `GET /sepolia/registry/stale-route.eth` with the named stubs, asserting the finding's expected 200, literal client and edge `Cache-Control: public, max-age=30`, and no ordinary metadata KV entry with `expirationTtl` greater than 30.
- [ ] T002 [AC1] Run that test on the baseline, save the failing transcript under `.postmaster/verify/`, and commit the regression before any product fix.
- [ ] T003 [AC2] Make the smallest product change so the same test passes without editing its expected assertions.
- [ ] T004 [AC2] Rerun `NO_COLOR=1 pnpm exec vitest run test/w3-routes-002.test.ts` and confirm the test diff did not weaken the expected behavior.
- [ ] T005 [AC3] Run `pnpm run test` at the lane head.
- [ ] T006 [AC4] Confirm the diff against `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` addresses only `W3-ROUTES-002`.
- [ ] T007 [AC5] Confirm the branch is descended from that main commit and contains no testing-campaign cherry-pick. Leave the pull request to landing.
