# Workhorse spec: WEB-1694 [W8-WEBHOOK-002] Fix testing-campaign finding on main (TDD)

## Summary

Fix a T3 runtime-validation gap in `src/services/webhook.ts`: the `validatePayload` method checks
`event_type`, `timestamp`, and the presence of `name`/`namehash`, but never validates that the
remaining identity fields (`block_number`, `tx_hash`, `log_index`, `contract_address`, `data`,
`protocol`) match their documented primitive types. This lets a malicious or malformed payload
with `block_number: null` pass validation, trigger full cache invalidation (KV deletes, R2
purges, batch-cache flush), return 200, and thus amplify an unauthenticated request into
cache-churn without ever validating the fields the interface declares.

The fix is TDD: write a focused regression test that fails on the current main baseline, then
add the missing type checks to `validatePayload` so the test passes and the project gate stays
green.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers (`@cloudflare/workers-types`)
- **Dependencies used or added**: None — the fix uses only the existing vitest test infrastructure and plain JavaScript `typeof` checks
- **Testing**: `pnpm run test` (vitest)
- **Constraints**:
  - TDD only: write the failing regression test first, record it, then fix
  - Must be cut from committed main (BASE `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`)
  - One finding only (`W8-WEBHOOK-002`); no other findings
  - No cherry-picks from testing-campaign
  - Minimal fix: add field-level type checks to `validatePayload`, nothing else

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: failing test first | Step 1 is a single commit adding the regression test; run `pnpm run test` to show it fails on the baseline, record that run |
| Fix only W8-WEBHOOK-002 | The fix adds type checks for the fields the interface declares, in `validatePayload` only |
| No cherry-picks from testing-campaign | Every line is freshly authored |
| One independent PR against main | Branch `WEB-1694` from BASE, no other changes |
| `pnpm run test` passes at head | Verified after the fix commit |

## Structure

| File | Change |
|---|---|
| `test/webhook.test.ts` | Add regression tests under the existing `payload validation` describe block: `block_number: null` produces 400, each identity field with wrong type produces 400 |
| `src/services/webhook.ts` | Extend `validatePayload` to check `block_number` (number), `tx_hash` (string), `log_index` (number), `contract_address` (string), `data` (string), `protocol` (`'v1'` or `'v2'`) |

## Complexity tracking

None. Every constraint in the ticket's direction is met as stated.

## Decisions

1. **Which fields to validate**: All identity fields in the `EnsNameEvent` interface that the
   `processWebhookEvent` path reads or that the interface declares with a primitive type:
   `block_number: number`, `tx_hash: string`, `log_index: number`, `contract_address: string`,
   `data: string`, `protocol: 'v1' | 'v2'`. The `name` and `namehash` fields are already
   checked (name for string-or-null, namehash only for presence); `event_type` and `timestamp`
   are already checked too.

2. **Error message per field**: One generic `"Missing or invalid <field>"` per field, matching
   the existing pattern in `validatePayload`.

3. **Null vs missing**: `null` on a required field is treated as invalid (the field's type is
   e.g. `number`, not `number | null`). A missing field (`undefined`) is also invalid — the
   existing code checks for `undefined` by letting `typeof` return `'undefined'`.

4. **Where to add tests**: In `test/webhook.test.ts`, under the existing `describe('payload
   validation', ...)` block. This is the natural location, follows the existing pattern (using
   `makeService`, `validEvent`, `makeCtx`), and makes the regression test easy to isolate.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded before any product fix commit | `pnpm run test -- --reporter=verbose test/webhook.test.ts` on the commit that adds only the regression test (no fix) | At least one test fails: the new test asserting `block_number: null` returns 400, while the current code returns 200. The failure output is captured. |
| AC2 | After the fix, that same focused regression passes without weakening its assertion | `pnpm run test -- --reporter=verbose test/webhook.test.ts` on the commit that adds the fix | All tests pass, including the new regression test. The assertion is exactly the same as in AC1 — it was not relaxed. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head | `pnpm run test` on the final HEAD (both commits) | Exit 0, all tests pass |
| AC4 | The change set addresses only `W8-WEBHOOK-002` and does not bundle another findings.md id | `git diff BASE...HEAD --stat` | Only `test/webhook.test.ts` and `src/services/webhook.ts` are changed |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign | Manual verification of branch name and `git log --oneline` | Branch is `WEB-1694`, all commits are authored fresh (no cherry-pick markers) |

## Tasks

- [ ] T001 [P] [AC1] Add the focused regression test in `test/webhook.test.ts` under the `payload validation` describe block: a test case that sends a valid event with `block_number: null` and expects 400. Run `pnpm run test` and record the failing output.
- [ ] T002 [P] [AC2] [AC3] [AC4] Extend `validatePayload` in `src/services/webhook.ts` to check: `block_number` is a number, `tx_hash` is a string, `log_index` is a number, `contract_address` is a string, `data` is a string, `protocol` is `'v1'` or `'v2'`. Return 400 with `"Missing or invalid <field>"` for any violation.
- [ ] T003 [AC2] [AC3] Run `pnpm run test` on the fix commit and verify the regression test passes and the full suite is green.