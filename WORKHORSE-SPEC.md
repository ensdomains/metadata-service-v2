# Workhorse spec: WEB-1663 [W3-NAMES-002] Fix testing-campaign finding on main (TDD)

## Summary

Garbage spellings of a token id must throw `InvalidTokenIdError`, never a bare `SyntaxError`. `tokenIdToHex("one")` today throws `SyntaxError: Cannot convert one to a BigInt`. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. `tokenIdToHex` already lives in `src/utils/ens.ts`. `InvalidTokenIdError` already lives in `src/services/errors.ts`.
- **Testing**: `pnpm exec vitest run <focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the bare-`SyntaxError` failure, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec.
- One finding, `W3-NAMES-002`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is `tokenIdToHex` itself, at `src/utils/ens.ts:101`, on the input `"one"`. The required demonstration is that call throwing `InvalidTokenIdError`. A change that leaves `tokenIdToHex("one")` throwing `SyntaxError` does not meet the ticket.
- `MetadataService.resolveTokenId` already rejects `"one"` before it calls `tokenIdToHex`. A route test, or a test of `resolveTokenId` alone, can pass on this baseline and still miss the finding. Do not treat that as the regression.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` and `.github/workflows/ci.yml` are the other docs to read. This ticket does not change the webhook, CI, cache policy, or HTTP routes.
- Degraded and outage responses must not be cached as healthy success. This change does not write cache entries. Do not add a cache write, and do not change a cache TTL, to make the regression pass.

## Structure

- A new focused regression under `test/`, calling `tokenIdToHex` with the spelling the finding names.
- A minimal product change so that call throws the existing `InvalidTokenIdError` instead of a bare `SyntaxError`. The lane chooses the mechanism.
- No other finding, no new package, no webhook, route, or cache-policy change.

## Decisions

- The regression calls `tokenIdToHex("one")` directly and expects `InvalidTokenIdError`. The ticket names that function, that file, and that input. It does not name an HTTP route.
- Asserting only that the call throws, without requiring `InvalidTokenIdError`, is not enough: the baseline already throws, and the thrown value is the bare `SyntaxError` the finding forbids. Asserting that the message contains `SyntaxError` would lock in the failure.
- The error type is the existing `InvalidTokenIdError` in `src/services/errors.ts`. Do not add a second class with that name. Do not move the class. Importing it from `tokenIdToHex` is allowed. A new error type that is not `InvalidTokenIdError` does not meet the finding.
- How the spelling is rejected is the lane's choice. Stopping the `BigInt` conversion from escaping as a bare `SyntaxError` is enough. Do not prescribe a helper, a regex, or a new type.
- Do not implement another finding. `W3-NAMES-001` is decimal and `0x` spellings sharing one padded representation. `W3-NAMES-003` is out-of-range values such as `2^256` throwing `InvalidTokenIdError`. Do not pad `0x` spellings. Do not add a uint256 range rejection. Do not add assertions that `"0"` and `"0x0"` are equal, or that `2^256` throws.
- Spellings that do not throw today keep today's return value. That includes decimal integers, `0x` spellings `tokenIdToHex` currently returns unchanged, and `2^256`. A fix that changes those return values bundles another finding.
- Other non-`0x` spellings that make `BigInt` throw `SyntaxError` today, such as `"abc"`, are the same defect as `"one"`. The regression must include `"one"`. A lane may include other spellings from that same `SyntaxError` class. It must not include `2^256` or a padding assertion.
- Callers that already pass a decimal integer or a `0x` spelling must keep working. `canonicalTokenId` and `getTokenIdVersion` call `tokenIdToHex`; do not change their contracts.
- The lane branch stays `wb/WEB-1663-<lane>`. The pull request is opened later, against main, from `WEB-1663`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test calls `tokenIdToHex("one")` and asserts that it throws `InvalidTokenIdError`. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is a bare `SyntaxError: Cannot convert one to a BigInt`, not `InvalidTokenIdError`. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts that `tokenIdToHex("one")` throws `InvalidTokenIdError`. The assertion was not changed to accept `SyntaxError`, to accept any thrown error, or to skip the call. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W3-NAMES-002` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the `tokenIdToHex` rejection of garbage spellings that today throw a bare `SyntaxError`. No other findings.md id is named as a bundled fix. No padding change for `0x` spellings. No uint256 range check. No drive-by refactor. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1663`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` that calls `tokenIdToHex("one")` and expects `InvalidTokenIdError`. Run it on the main baseline and record the bare `SyntaxError: Cannot convert one to a BigInt` before any product fix.
- [ ] T002 [AC2] Change `tokenIdToHex` so `"one"` throws the existing `InvalidTokenIdError` instead of a bare `SyntaxError`. Do not weaken the assertion. Do not pad `0x` spellings. Do not add a uint256 range check.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
