# Workhorse spec: WEB-1664 [W3-NAMES-003] Fix testing-campaign finding on main (TDD)

## Summary

Token ids are uint256. Decimal `2^256`, the input named in finding `W3-NAMES-003`, must throw `InvalidTokenIdError` from the conversion at `src/utils/ens.ts` that today returns a 65-digit hex value. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Vitest, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. Use the existing `InvalidTokenIdError` in `src/services/errors.ts` and the existing token-id conversion in `src/utils/ens.ts`.
- **Testing**: `pnpm exec vitest run <focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record that decimal `2^256` returns a 65-digit hex value instead of throwing `InvalidTokenIdError`, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec. Do not read the primary checkout, other branches, or `.worktrees/`.
- One finding, `W3-NAMES-003`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is the conversion at `src/utils/ens.ts` (the finding's line is inside `tokenIdToHex`) returning a 65-digit hex for decimal `2^256`. A change that leaves that call returning a 65-digit hex does not meet the ticket. The service-layer range check in `MetadataService.resolveTokenId` already rejects this input; that check is not this finding and is not a substitute for it.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` is out of scope.

## Structure

- A new focused regression under `test/`, calling the existing token-id conversion the finding names, with decimal `2^256`.
- A minimal product change so that conversion throws `InvalidTokenIdError` for an out-of-range token id instead of returning a wider-than-uint256 hex. The lane chooses the mechanism.
- No other finding, no new package, no route, cache, or webhook change unless the chosen mechanism cannot compile without a one-line caller adjustment. Do not restyle callers.

## Decisions

- The regression calls `tokenIdToHex` with the decimal string of `2^256` and asserts it throws `InvalidTokenIdError`. It does not accept a returned hex of any width. That is the ticket's named behavior, not a function shape the lane invents: the function already exists and is the site that returns the 65-digit hex.
- Also assert one in-range boundary, decimal `2^256 - 1`, still converts to ``0x`` plus 64 `f` digits. A fix that throws for every input must not pass.
- Out-of-range means `>= 2^256`, decimal or `0x`-prefixed. The minimized input is decimal; the same function must not still return a 65-digit hex for `0x` + `1` + 64 zeros. Rejecting that hex form is this invariant, not a second finding.
- In-range behavior stays as it is today: decimal values from `0` through `2^256 - 1` still become a `0x`-prefixed 64-digit hex, and an in-range `0x` value that the function currently returns unchanged still returns unchanged.
- Non-numeric input that today throws `SyntaxError` from `BigInt` is out of scope. Do not retarget that path unless the range check cannot be added without it. Do not bundle the older non-numeric token-id finding.
- `constructEthNameHash` is a different converter. Change it only if the lane's fix to `tokenIdToHex` requires it, or if decimal `2^256` currently returns a 65-digit hex from it. Do not use it as a drive-by.
- The lane branch stays `wb/WEB-1664-<lane>`. The pull request is opened later, against main, from `WEB-1664`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test calls `tokenIdToHex` with the decimal string of `2^256` and asserts `InvalidTokenIdError`. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is a returned 65-digit hex value, not a thrown `InvalidTokenIdError`. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts `InvalidTokenIdError` for decimal `2^256`. The assertion was not changed to accept a 65-digit hex, to accept either outcome, or to skip the throw. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W3-NAMES-003` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the uint256 rejection for this finding. No other findings.md id is named as a bundled fix. No drive-by refactor. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1664`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` that calls `tokenIdToHex` with decimal `2^256` and expects `InvalidTokenIdError`, run it on the main baseline, and record the 65-digit-hex failure before any product fix.
- [ ] T002 [AC2] Make that conversion throw `InvalidTokenIdError` for an out-of-range token id, so the same test passes. Do not weaken the assertion. Leave in-range conversion unchanged.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
