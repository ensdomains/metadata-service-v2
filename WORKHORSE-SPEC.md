# Workhorse spec: WEB-1671 [W3-ROUTES-006] Fix testing-campaign finding on main (TDD)

## Summary

Fix the migration-status route so that a D1 rescue after a non-definitive live-source miss is
recognized privately as degraded. Preserve the exact public 200 JSON without exposing that
provenance, and publish both the client response and the captured edge-cache response with the
literal header `Cache-Control: public, max-age=30` rather than healthy-success caching.

## Technical context

- **Language and version**: TypeScript 5.9, Cloudflare Workers (Hono)
- **Dependencies used or added**: None new
- **Testing**: `pnpm run test` (vitest); a new focused regression covers the complete degraded
  response path for migration status rescued from D1 after a non-definitive `NotFoundError`
- **Constraints**: TDD on main baseline — write a failing regression test first, record it, then
  fix; do NOT copy or cherry-pick from testing-campaign; the change set addresses only
  W3-ROUTES-006

## Direction check

| Constraint | How met |
|---|---|
| Fix on main baseline only | All work in the `WEB-1671` branch cut from `5a5527c` |
| TDD: regression test fails first | Write a test that exercises the D1 rescue path for migration status, confirm failure, record it |
| One finding only (W3-ROUTES-006) | The diff touches only the migration-status response path; no other finding is addressed |
| No cherry-picks from testing-campaign | The regression and fix are written independently against main; testing-campaign supplies no implementation or test code |
| `pnpm run test` passes | Gate verified before final commit |
| PR against main | Branch `WEB-1671`, no testing-campaign dependency |

## Structure

Expected change areas:
- `src/services/metadata.ts` — retain private degraded provenance on a migration-status value
  rescued from D1 after the specified non-definitive live miss
- `src/index.ts` — make the migration-status route use degraded client and edge-cache policy
  while serializing the unchanged public payload
- `test/` — add one focused regression file that exercises the D1 rescue path end-to-end

## Complexity tracking

No departures from the ticket's direction. The fix follows the same pattern the project already
uses for metadata and hierarchy D1 rescues.

## Decisions

1. **Private degraded provenance**: Carry enough non-serialized state from the service layer to
   the route for it to distinguish this rescue from a healthy success. The state must not add,
   remove, or alter any field in the public JSON.
2. **Trigger boundary**: Apply degraded treatment when the live lookup raises
   `NotFoundError({ definitive: false })` and D1 supplies the migration-status row. Preserve the
   existing behavior of definitive misses and every other success or failure path.
3. **Cache boundary**: Apply the literal `Cache-Control: public, max-age=30` to both the response
   sent to the client and the response passed to edge-cache storage. Do not retain the healthy
   `max-age=300` or `stale-while-revalidate=30` directives on either copy.
4. **Regression scope**: The focused regression must prove the service result is privately marked
   degraded, the public 200 body is exactly the expected migration-status JSON with no provenance,
   and both client and captured-edge cache-control values equal the required literal string.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit | Run only the new regression file before changing product code | The unchanged assertion expects private degraded provenance, exact provenance-free public 200 JSON, and literal client and captured-edge `Cache-Control: public, max-age=30`; the baseline fails because provenance is absent and healthy cache headers are emitted |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior | Rerun the identical focused regression file after the product fix | The unchanged regression passes all service, payload, client-header, and captured-edge-header assertions |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head | `pnpm run test` in synthesis worktree | All tests pass, exit 0 |
| AC4 | The change set addresses only `W3-ROUTES-006` and does not bundle another findings.md id | Manual review of diff | Diff touches only migration-status degraded-response path |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff | Manual review of commit history | All commits are original, no `cherry-pick` from testing-campaign in log |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression at `test/w3-routes-006.test.ts` for
  `GET /migration-status/non-definitive-migration.eth?network=sepolia`: mock the live migration
  lookup to throw `NotFoundError({ definitive: false })`, return a migrated row from D1, and
  assert the expected private degraded provenance, exact provenance-free public 200 JSON, and
  literal client and captured-edge `Cache-Control: public, max-age=30`
- [ ] T002 [T001] [AC1] Before changing product code, run only that regression on the main-based
  branch and record the failing command, output, and exit status in the run record
- [ ] T003 [T002] [AC2] Preserve private degraded provenance on the D1-rescued migration-status
  value only when the preceding live miss is non-definitive
- [ ] T004 [T003] [AC2] Consume that provenance in the migration-status route so both the client
  response and captured edge-cache response use the required degraded header without changing
  the public JSON
- [ ] T005 [T004] [AC2] Rerun the identical focused regression and confirm every original
  assertion passes
- [ ] T006 [T005] [AC3] Run `pnpm run test` at branch head and ensure it exits successfully
- [ ] T007 [T006] [AC4] Review the diff to confirm it addresses only W3-ROUTES-006
- [ ] T008 [T007] [AC5] Open the ticket-named branch's pull request against `main` and verify its
  history requires no testing-campaign cherry-pick to explain the diff