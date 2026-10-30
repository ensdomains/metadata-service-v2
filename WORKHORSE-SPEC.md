# Workhorse spec: WEB-1672 [W3-ROUTES-007] Fix testing-campaign finding on main (TDD)

## Summary

Make `GET /registry-hierarchy/:name` total when its pre-service expiry check cannot read upstream state. If `MetadataService.checkExpiry()` throws `UpstreamError`, the route must return the normal degraded hierarchy placeholder rather than a 503 error response.

For `GET /registry-hierarchy/precheck-outage.eth?network=mainnet`, the response must be HTTP 200 with a two-level, zero-owner placeholder and literal `Cache-Control: public, max-age=30`. The same short-lived header must be present on the response captured for the edge-cache write. The hierarchy service must not run after the failed expiry pre-check.

## Technical context

- TypeScript service running as a Cloudflare Worker with Hono.
- Relevant production route is in `src/index.ts`.
- Existing error and cache abstractions include `UpstreamError` and the short-lived error cache policy.
- No dependencies are required.
- Project gate: `pnpm run test`.

## Constraints

- Start from committed `main`, on a branch named for WEB-1672.
- Follow TDD: add the focused regression first, run it against the unfixed main-based code, and record the expected failure before any product-fix commit.
- Write the regression and fix fresh against main. Do not copy, cherry-pick, or transplant the testing-campaign implementation or tests.
- Address only `W3-ROUTES-007`; do not include another finding or a drive-by refactor.
- Keep the regression's behavioral assertions unchanged when making it pass.
- Treat the placeholder as a degraded response: its client and edge-cache TTL is 30 seconds, not a healthy-success TTL.

## Behavioral decisions

1. **Failure boundary**: This behavior applies when the route's pre-service `checkExpiry()` call throws `UpstreamError`. It must not turn unrelated failures into successful placeholders.
2. **HTTP result**: The route returns status 200 rather than the generic 503 error JSON.
3. **Placeholder**: The body is a two-level hierarchy for the requested second-level `.eth` name and its `eth` parent, with zero-address owners at both levels. Preserve the route's established hierarchy response schema and placeholder defaults for fields not specified here.
4. **Caching**: The client response and the response passed to the edge-cache write both have the literal header `Cache-Control: public, max-age=30`. The degraded placeholder is written to the edge cache using that short-lived policy.
5. **Short circuit**: Once the expiry pre-check fails, the hierarchy service is not called.
6. **Existing behavior**: Preserve behavior for successful expiry checks and errors outside this finding.

## Test requirements

Add a focused route-level regression that drives the reported HTTP request through the worker with controlled dependencies:

- request: `GET /registry-hierarchy/precheck-outage.eth?network=mainnet`;
- arrange for `MetadataService.checkExpiry()` to throw `UpstreamError`;
- capture the response supplied to the edge-cache write;
- spy on the hierarchy-service call;
- assert status 200;
- assert the response is the two-level placeholder for `precheck-outage.eth` and `eth`, with zero-address owners at both levels;
- assert the client response has exactly `Cache-Control: public, max-age=30`;
- assert the captured edge response has exactly `Cache-Control: public, max-age=30`;
- assert one degraded placeholder edge write occurs;
- assert the hierarchy service is not called.

The pre-fix run must fail because the current route returns 503 rather than this placeholder behavior. Record that command, exit status, and relevant failure output in the run record before committing any production fix. After the fix, rerun the same test without weakening or replacing its assertions.

## Showing each criterion

| # | Criterion | Evidence |
|---|---|---|
| AC1 | A new focused regression on a branch cut from main fails on the main baseline as reported, and the failure is recorded before any product fix commit. | Main ancestry/branch evidence plus the recorded focused-test command, nonzero exit status, and expected 503-versus-200 failure from the test-only state. |
| AC2 | The unchanged focused regression passes after the fix and covers the complete expected behavior. | Passing focused run asserting the 200 two-level zero-owner placeholder, literal client and captured-edge cache headers, edge write, and no hierarchy-service call. |
| AC3 | `pnpm run test` passes at branch head. | Full gate output with exit code 0. |
| AC4 | Only `W3-ROUTES-007` is addressed. | Base-to-head diff contains only the focused regression and minimal route fix, with no other finding IDs or unrelated refactors. |
| AC5 | The pull request is main-based and independently explainable. | PR targets `main`, source branch is named for WEB-1672, and history/diff contains no testing-campaign cherry-picks. |

## Tasks

- [ ] T001 [AC1] Add the focused route-level regression and record its expected failure on the unfixed main-based code before any production-fix commit.
- [ ] T002 [AC2] Make the minimal route change needed to return and short-cache the degraded placeholder after a pre-service `UpstreamError`, without invoking the hierarchy service.
- [ ] T003 [AC2] Rerun the same focused regression unchanged and record its passing result.
- [ ] T004 [AC3] Run `pnpm run test` at branch head and record a passing result.
- [ ] T005 [AC4, AC5] Review the base-to-head diff, history, branch name, and PR base to confirm the change is isolated to W3-ROUTES-007 and based directly on main.
