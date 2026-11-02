# Workhorse spec: WEB-1693 [W8-WEBHOOK-001] Fix testing-campaign finding on main (TDD)

## Summary

Add runtime validation that the webhook `protocol` field is exactly `"v1"` or `"v2"` before any cache purge, persistence, or warming side effects execute. Currently `validatePayload` does not check `protocol` at all; a payload with `protocol: ""` (or any non-`v1`/`v2` value) passes validation, triggers six internal cache deletes plus batch invalidation, and falls into the v1 network fan-out path. The fix adds the missing validation and rejects invalid protocol values with a `400` response.

## Technical context

- **Language and version**: TypeScript (Cloudflare Workers + Hono)
- **Dependencies used or added**: None — no new dependencies
- **Testing**: `pnpm run test` (vitest)
- **Constraints**:
  - TDD on main baseline: write a failing regression test first, record it, then fix
  - One finding only: `W8-WEBHOOK-001`; do not bundle any other findings.md id
  - Independent PR against main; no cherry-picks from testing-campaign
  - The change is in `src/services/webhook.ts` only (the `validatePayload` method)
  - `protocol` is the ENS version (`"v1"` | `"v2"`), never the chain

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: regression test first, recorded failing on main baseline | Add one focused test in `test/webhook.test.ts` under the `payload validation` describe block for `protocol: ""`; commit it, run `pnpm run test` to record the failure, then fix |
| Only W8-WEBHOOK-001 | No other validation gaps (block_number, tx_hash, etc.) are touched; those are separate findings |
| No cherry-picks from testing-campaign | The regression test and fix are rewritten against main from the finding's description |
| protocol ∈ {v1, v2} runtime validation | Add a check in `validatePayload` that `payload.protocol` is a string equal to `'v1'` or `'v2'` |
| 400 on invalid protocol, no cache invalidation | Validation happens before `processWebhookEvent` runs, so invalid protocol returns 400 before any cache side effects |

## Structure

Only one file changes:
- `src/services/webhook.ts` — the `validatePayload` method adds a protocol check

One test file adds a test:
- `test/webhook.test.ts` — one new `it(...)` block under the existing `payload validation` describe

## Decisions

1. **Validation placement**: The check goes in `validatePayload` alongside the existing `event_type`, `timestamp`, and name checks. This is the natural place — it runs before `processWebhookEvent` and before the index.ts `handleWebhook` wrapper's protocol-based network selection.
2. **Valid values**: Only `"v1"` and `"v2"` are valid. The TypeScript interface already declares `protocol: 'v1' | 'v2'`; the runtime check mirrors that type.
3. **Error message**: `'Invalid protocol; must be "v1" or "v2"'` — consistent with the style of existing validation error messages.
4. **Test scope**: The regression test uses the existing unauthenticated dev path (`allowUnauthenticated: true`) with `protocol: ""` and asserts both a 400 status and that no cache deletes occurred.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | `pnpm run test -- --run test/webhook.test.ts` on the commit that adds only the regression test (no product fix) | One test fails: `rejects protocol: "" with 400` — it expects 400 but gets 200 (or expects no cache deletes but sees them). The failing output is recorded in the run log. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | Same command on the commit that includes the product fix | All webhook tests pass. The protocol test asserts: (a) status is 400, (b) body contains the protocol error message, (c) no `cache.delete` calls were made, (d) no `metadataCacheKv.delete` calls were made. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `pnpm run test` at the final synthesis HEAD | Exit 0, all tests pass. |
| AC4 | The change set addresses only `W8-WEBHOOK-001` and does not bundle another findings.md id. | `git diff BASE...HEAD` — only `src/services/webhook.ts` and `test/webhook.test.ts` changed | No other findings addressed; no changes to other validation gaps. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | The branch is `WEB-1693` cut from main at BASE; the diff shows only commits written on this branch | The PR diff is self-contained against main. |

## Tasks

- [ ] T001 [P] [AC1] Add regression test in `test/webhook.test.ts`: a test that sends `protocol: ""` and asserts 400 + no cache invalidation. Commit it alone on the ticket branch.
- [ ] T002 [P] [AC1] Run `pnpm run test -- --run test/webhook.test.ts` on the T001 commit to record the failing baseline in the run log.
- [ ] T003 [AC2] Add protocol validation in `src/services/webhook.ts` `validatePayload`: check that `typeof payload.protocol === 'string'` and `payload.protocol === 'v1' || payload.protocol === 'v2'`, return 400 if not.
- [ ] T004 [AC2] Run the regression test again: `pnpm run test -- --run test/webhook.test.ts` — all pass.
- [ ] T005 [AC3] Run full gate: `pnpm run test` — exit 0.