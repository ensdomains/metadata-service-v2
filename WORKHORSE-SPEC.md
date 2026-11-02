# Workhorse spec: WEB-1711 [W8-MEDIA-002] Fix testing-campaign finding on main (TDD)

## Summary

Fix finding W8-MEDIA-002: when `fetchMediaUrl` follows a redirect that changes POST to GET without a body (HTTP 301/302 after POST), it must delete every Fetch request-body header — `Content-Encoding`, `Content-Language`, `Content-Location`, and `Content-Type` — not only `Content-Type`. The fix is a minimal change at `src/services/media-fetch.ts:176-182`, delivered as an independent TDD PR from main.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime (tested with vitest)
- **Dependencies used or added**: None new. Uses existing vitest + vi.fn() mocking.
- **Testing**: `pnpm run test` (vitest); the focused regression test lives at `test/invariants/regressions/media-redirect-body-headers.test.ts`
- **Constraints**: Must not copy/cherry-pick from testing-campaign; independent PR targeting main; only W8-MEDIA-002; no drive-by refactors

## Direction check

Each constraint from the ticket's direction and how this plan meets it:

- **TDD from BASE**: The regression test is written first and verified to fail on the BASE baseline before any product code change.
- **Independent PR from main**: Branch cut from main at BASE `5a5527c7`, never cherry-picked from testing-campaign.
- **One finding only**: The change touches only the header-deletion logic in `fetchMediaUrl` and adds only the corresponding regression test.
- **No testing-campaign code**: The test is written fresh from the finding description, not copied from the testing-campaign branch.

## Structure

| File | Change |
|---|---|
| `src/services/media-fetch.ts` | `fetchMediaUrl`: expand the header-deletion loop from `content-type` only to all four Fetch request-body headers |
| `test/invariants/regressions/media-redirect-body-headers.test.ts` | New: focused regression test for W8-MEDIA-002 |

## Complexity tracking

No departures.

## Decisions

- **Header list**: The Fetch spec defines four request-body headers that must be removed when a redirect strips the body: `Content-Encoding`, `Content-Language`, `Content-Location`, `Content-Type`. The fix deletes all four.
- **Test location**: `test/invariants/regressions/` follows the existing project convention for invariants (see `test/invariants/regressions/media-nonredirect-location.test.ts` and `media-redirect-body-headers.test.ts` on the testing-campaign branch, which establish this pattern).
- **Test style**: Uses `vi.stubGlobal('fetch', …)` mocking as established in `test/media-decision-tables.test.ts`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | `pnpm run test -- test/invariants/regressions/media-redirect-body-headers.test.ts` on the BASE baseline (before the fix commit) | Test fails: `Content-Encoding` header is still present after the redirect, because only `Content-Type` is deleted. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `pnpm run test -- test/invariants/regressions/media-redirect-body-headers.test.ts` after the fix commit | Test passes: `Content-Encoding` is removed, `Accept` is preserved, method is GET, body is undefined. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` from the synthesis worktree root | All tests pass, exit 0. |
| AC4 | The change set addresses only `W8-MEDIA-002` and does not bundle another findings.md id. | `git diff BASE...HEAD` | Only `src/services/media-fetch.ts` (header-deletion fix) and `test/invariants/regressions/media-redirect-body-headers.test.ts` (new regression test) are changed. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git log --oneline BASE..HEAD` | Only commits authored in this run; no testing-campaign commits present. |

## Tasks

- [ ] T001 [P] [AC1] Write the focused regression test at `test/invariants/regressions/media-redirect-body-headers.test.ts`: a POST carrying `Content-Encoding: gzip` and `Accept: image/*` followed through an HTTP 301 redirect, asserting the redirected request drops `Content-Encoding`, keeps `Accept`, has method GET, and has no body.
- [ ] T002 [P] [AC3] Create the test directory `test/invariants/regressions/` (may already exist from the test commit).
- [ ] T003 [AC2] Fix `src/services/media-fetch.ts:176-182`: expand the header-deletion condition from `key.toLowerCase() === 'content-type'` to `['content-encoding', 'content-language', 'content-location', 'content-type'].includes(key.toLowerCase())`.
- [ ] T004 [AC3] Run `pnpm run test` and verify all tests pass.
- [ ] T005 [AC4] Verify the diff contains only the two expected files.
- [ ] T006 [AC5] Verify the branch history contains no testing-campaign cherry-picks.