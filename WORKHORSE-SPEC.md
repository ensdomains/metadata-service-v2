# Workhorse spec: WEB-1665 [W3-ROUTES-001] Fix testing-campaign finding on main (TDD)

## Summary

An outage-derived registry-hierarchy placeholder must be cached for 30 seconds at the client and at the edge, not as a healthy hierarchy. Show it with `GET /registry-hierarchy/outage.eth?network=mainnet` after every hierarchy source throws `UpstreamError` and D1 misses: the response is 200 with the placeholder, and both the client and the captured edge `Cache-Control` are `public, max-age=30`. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Hono, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. Use the existing app request path, `UpstreamError`, and the per-colo edge cache (`caches.default`).
- **Testing**: `pnpm exec vitest run <focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only. An outage placeholder must not be cached as a healthy success.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the healthy-TTL failure, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec.
- One finding, `W3-ROUTES-001`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is the outage placeholder leaving the route as a healthy hierarchy cache entry. On main the route applies `CachePresets.hierarchy` (client `public, max-age=300, stale-while-revalidate=60`) and `edgeCachePut` stores that OK response at the default edge cap (`public, max-age=300`). The required demonstration is the request in the finding. A change that leaves either header on the healthy TTL does not meet the ticket.
- Degraded and outage responses must not be cached as healthy success. This placeholder is an outage answer. It stays a 200 placeholder. It must not carry the healthy hierarchy TTL, and the edge copy must not be stored for 300 seconds.
- A healthy hierarchy, a stale D1 hierarchy rescue, and a blockchain-sourced hierarchy are not this finding. Do not change their TTLs to make this test pass.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` is out of scope unless a mistake in the fix touches the webhook.

## Structure

- A new focused regression under `test/`, driving the public route named in the finding.
- A minimal product change so that outage-derived hierarchy placeholder uses the 30-second error TTL on the response the client receives and on the response stored in the edge cache. The lane chooses the mechanism.
- No other finding, no new package, no webhook, and no unrelated route or TTL change.

## Decisions

- The regression hits `GET /registry-hierarchy/outage.eth?network=mainnet` on the real app. Every hierarchy source throws `UpstreamError`. D1 misses. `checkExpiry` must not be the failure under test: it resolves, so the request reaches hierarchy resolution. The test asserts status 200, a placeholder body (the name, and hierarchy levels whose owner is the zero address), client `Cache-Control: public, max-age=30`, and the captured edge entry's `Cache-Control: public, max-age=30`. It does not accept `max-age=300` or `stale-while-revalidate=60`.
- How the placeholder is recognized, and how the edge put is given 30 seconds instead of the 300-second cap, is the lane's choice. Either shape is acceptable if that minimized input returns the 200 placeholder with both headers exactly `public, max-age=30`, and a healthy hierarchy response is unchanged.
- Do not turn this outage into a 503 or a 500 to satisfy the TTL. The finding's expected behavior is the 200 placeholder with the error TTL.
- The lane branch stays `wb/WEB-1665-<lane>`. The pull request is opened later, against main, from `WEB-1665`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test requests `GET /registry-hierarchy/outage.eth?network=mainnet` after every hierarchy source throws `UpstreamError` and D1 misses, and asserts a 200 placeholder with client and captured edge `Cache-Control: public, max-age=30`. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is the client header `public, max-age=300, stale-while-revalidate=60` and the edge header `public, max-age=300`, not a missing route or a non-200. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts status 200, the placeholder, and both client and captured edge `Cache-Control: public, max-age=30`. The assertion was not changed to accept 300, to accept `stale-while-revalidate`, or to skip either header. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W3-ROUTES-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the error-TTL fix for this finding. No other findings.md id is named as a bundled fix. No drive-by refactor. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1665`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` for `GET /registry-hierarchy/outage.eth?network=mainnet` after every hierarchy source throws `UpstreamError` and D1 misses. Run it on the main baseline and record the healthy-TTL failure before any product fix.
- [ ] T002 [AC2] Make that outage placeholder use `Cache-Control: public, max-age=30` on the client response and on the captured edge entry. Do not weaken the assertion. Do not change a healthy hierarchy's TTL.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
