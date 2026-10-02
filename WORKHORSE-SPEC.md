# Workhorse spec: WEB-1667 [W3-ROUTES-003] Fix testing-campaign finding on main (TDD)

## Summary

A non-definitive registry-hierarchy miss is a skipped or unavailable primary, so the mandatory 200 zero-owner placeholder is degraded and must not be published as a normal success. Today that placeholder is returned with no public provenance leak, but the internal cache value drops the degraded provenance, the client is told `public, max-age=300, stale-while-revalidate=60`, and the edge stores `public, max-age=300`. Land the fix as TDD cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. The route is `GET /registry-hierarchy/:name` in `src/index.ts`. The hierarchy read and its internal cache write are `MetadataService.getRegistryHierarchy` in `src/services/metadata.ts`. Cache header presets live in `src/utils/cache-headers.ts`. The edge put is `edgeCachePut` in `src/index.ts`.
- **Testing**: `pnpm exec vitest run <the new focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the failure the finding describes, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec. Do not read `.worktrees/`, other branches, or the primary checkout.
- One finding, `W3-ROUTES-003`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The minimized input is `GET /registry-hierarchy/non-definitive.eth?network=sepolia` with `FallbackService.getRegistryHierarchy()` throwing `NotFoundError({ definitive: false })` and D1 missing. A test that never hits that route, or that uses a different error, does not show the finding.
- Expected on that input: 200 zero-owner placeholder; private degraded provenance; literal client and captured-edge `Cache-Control: public, max-age=30`; no public `_provenance`.
- Actual on this baseline: 200 zero-owner placeholder and no public provenance leak, but the internal cache value loses degraded provenance; client receives `public, max-age=300, stale-while-revalidate=60` and edge stores `public, max-age=300`.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` and `.github/workflows/ci.yml` are the other docs to read. This ticket does not change the webhook or CI.
- Degraded and outage responses must not be cached as healthy success. This finding is that rule for the hierarchy placeholder. Do not "fix" it by deleting the placeholder, by returning 404, or by skipping the internal cache entirely.

## Structure

- A new focused regression under `test/`, driving the registry-hierarchy route with the minimized input.
- A minimal product change so that input is published as a degraded 200, not as a healthy hierarchy success. The lane chooses the mechanism.
- No other finding, no new package, no webhook or CI change.

## Decisions

- The regression is an HTTP check of `GET /registry-hierarchy/non-definitive.eth?network=sepolia`, not a unit test that only calls `generateBasicHierarchy`. The ticket names that request. Stub `FallbackService.getRegistryHierarchy` to reject with `NotFoundError` whose `definitive` is `false`. Pass no D1 binding (`DB` absent), which is what "D1 missing" means. An empty D1 row is a different path and is not this finding.
- `checkExpiry` is not part of the finding. Stub it to resolve so the request reaches the hierarchy read. Do not change `checkExpiry` to make the regression pass.
- The 200 body is the zero-owner placeholder: `name` is `non-definitive.eth`, and `hierarchy` is `eth` at level 1 then `non-definitive.eth` at level 2, every `owner` the zero address `0x0000000000000000000000000000000000000000`. No other top-level keys. In particular no `_provenance` anywhere in the JSON, and no `provenance` key on the public body.
- "Literal" `Cache-Control` means the header string is exactly `public, max-age=30`. A value that merely contains `max-age=30`, or that adds `stale-while-revalidate`, does not pass. Assert the client response header and the `Cache-Control` on the `Response` stored in `caches.default` for that URL. Do not assert only a parsed max-age.
- Private degraded provenance is not a public field. How it is stored is the lane's choice. It is shown by this check: after the first response, clear the edge cache and keep the internal KV entry; a second GET of the same URL must not call `FallbackService.getRegistryHierarchy` again, must still be the same 200 placeholder with no public `_provenance`, and must still send literal `Cache-Control: public, max-age=30` on the client and on the newly captured edge entry. A second response that is served from the internal cache with the healthy hierarchy header fails this finding even if the first response was short.
- Do not stop caching the placeholder. The second request must be answered from the internal cache. Dropping the cache write so the live tier runs again is not the fix.
- A healthy hierarchy success keeps today's client header `public, max-age=300, stale-while-revalidate=60` and today's edge cap of 300 seconds. Do not shorten `CachePresets.hierarchy` for every hierarchy response to make this one case pass.
- A definitive miss (`NotFoundError` with `definitive: true`) is not this finding. Do not redesign that path. `W3-ROUTES-004` is migration status. `W3-ROUTES-005` is metadata. Do not bundle either, and do not add their tests.
- The lane branch stays `wb/WEB-1667-<lane>`. The pull request is opened later, against main, from `WEB-1667`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. The failure must be the finding's failure: client `Cache-Control` is `public, max-age=300, stale-while-revalidate=60` and the captured edge entry is `public, max-age=300`, while the body is already the 200 zero-owner placeholder with no public `_provenance`. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test sends `GET /registry-hierarchy/non-definitive.eth?network=sepolia` with `FallbackService.getRegistryHierarchy()` throwing `NotFoundError({ definitive: false })`, no D1 binding, and `checkExpiry` resolving. It asserts the 200 zero-owner placeholder, no public `_provenance`, literal client and captured-edge `Cache-Control: public, max-age=30`, and a second GET served from the internal cache (edge cleared, KV kept, fallback not called again) with the same body and the same literal header. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The body is already the 200 zero-owner placeholder with no `_provenance`. The failure is the client header `public, max-age=300, stale-while-revalidate=60` and the captured edge header `public, max-age=300`. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts literal `public, max-age=30` on the client and on the captured edge entry, the zero-owner placeholder, no public `_provenance`, and the cache-hit repeat. The assertion was not changed to accept `max-age=300`, to accept `stale-while-revalidate`, to skip the edge entry, or to drop the second request. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W3-ROUTES-003` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the minimal hierarchy degraded-cache fix. No other findings.md id is named as a bundled fix. No migration-status change. No metadata-route change. No drive-by refactor. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1667`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` for `GET /registry-hierarchy/non-definitive.eth?network=sepolia` with a non-definitive hierarchy miss and D1 missing. Run it on the main baseline and record the healthy-cache failure before any product fix.
- [ ] T002 [AC2] Publish that placeholder as degraded: literal client and edge `Cache-Control: public, max-age=30`, private degraded provenance retained across an internal-cache hit, no public `_provenance`. Do not weaken the assertion. Do not change healthy hierarchy caching. Do not bundle another finding.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
