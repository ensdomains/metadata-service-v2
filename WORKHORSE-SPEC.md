# Workhorse spec: WEB-1662 [W3-NAMES-001] Fix testing-campaign finding on main (TDD)

## Summary

Decimal and `0x` spellings of one token id must have one `tokenIdToHex` representation. `"0"` and `"0x0"` both return `0x` plus 64 zeroes. Today the decimal spelling is padded and the `0x` spelling is returned unchanged, mixed-case hex included. Land that as a TDD fix cut from committed main, for this finding only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers, Node >= 18. No new dependency.
- **Dependencies used or added**: none added. `tokenIdToHex` already lives in `src/utils/ens.ts` and is called by name resolution and `canonicalTokenId`.
- **Testing**: `pnpm exec vitest run <focused regression file>` for the finding; `pnpm run test` for the project gate. Install with `pnpm install --frozen-lockfile` if `node_modules` is absent.
- **Constraints**: cut from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Failing regression recorded before any product fix commit. Do not copy a testing-campaign patch. One finding only.

## Direction check

- TDD on the main baseline: the worktree is already cut from main. Add the regression, run it, record the unpadded-`0x0` failure, and only then change product code.
- Do not copy, cherry-pick, or transplant the audit implementation or its tests. Rewrite the regression and the fix from this baseline and this spec.
- One finding, `W3-NAMES-001`. No other findings.md id, no drive-by refactor, no weakened assertion.
- The cited failure is `tokenIdToHex` itself. The required demonstration is `"0"` and `"0x0"`. A change that leaves `tokenIdToHex("0x0")` as `0x0` does not meet the ticket.
- The actual also preserves mixed-case hex. A `0x` spelling whose hex digits differ only in case must return the same padded lowercase form as the decimal spelling of that integer. A fix that special-cases zero and still returns `0xA` unchanged does not meet the invariant.
- No AGENTS.md. README.md is the project context. `docs/webhook.md` and `.github/workflows/ci.yml` are the other docs to read. This ticket does not change the webhook, CI, cache policy, or HTTP routes.
- Degraded and outage responses must not be cached as healthy success. This change does not write cache entries. Do not add a cache write, and do not change a cache TTL, to make the regression pass.

## Structure

- A new focused regression under `test/`, calling `tokenIdToHex` with the spellings the finding names.
- A minimal product change in `tokenIdToHex` so those spellings share one representation. The lane chooses the mechanism.
- No other finding, no new package, no webhook, route, or cache-policy change.

## Decisions

- The regression calls `tokenIdToHex` directly. The ticket names that function, that file, and those inputs. It does not name an HTTP route. Do not satisfy the finding only through a route test that never calls `tokenIdToHex`.
- Both `"0"` and `"0x0"` must equal the string `0x` plus 64 zeroes. Asserting only that the two calls equal each other is not enough: both returning `0x0` would pass that weaker check and miss the finding.
- Mixed-case is in the finding's actual. `tokenIdToHex("0xA")`, `tokenIdToHex("0xa")`, and `tokenIdToHex("10")` must be the same string: `0x` plus 63 zeroes plus `a`. Include that in the regression. Do not drop it after the first failure is seen.
- How the spelling is canonicalized is the lane's choice. Parsing a `0x` integer spelling the same way the decimal spelling is already parsed is enough. Do not prescribe a helper, a regex, or a new type.
- Do not implement another finding. `W3-NAMES-002` is garbage spellings throwing `InvalidTokenIdError`. `W3-NAMES-003` is out-of-range values throwing `InvalidTokenIdError`. Do not add that error type. Do not add a uint256 range rejection. Do not add assertions for `"one"` or for `2^256`. Spellings that are not a decimal integer or a `0x` hex-integer spelling keep today's behavior.
- Callers that already pass a decimal integer or an already-padded lowercase hex id must keep working. `canonicalTokenId` and name resolution call `tokenIdToHex`; do not change their contracts.
- The lane branch stays `wb/WEB-1662-<lane>`. The pull request is opened later, against main, from `WEB-1662`. The lane does not push and does not rename its branch.
- Record the failing focused run before the product-fix commit. On this run the coachman also records that failure in the dispatch run record; the lane still records its own transcript before its fix commit.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline in the way this finding describes, and that failing run is recorded in the run record before any product fix commit. | Before any product-fix commit, run `pnpm exec vitest run <the new focused regression file>`. The test calls `tokenIdToHex("0")` and `tokenIdToHex("0x0")` and asserts each equals `0x` plus 64 zeroes. Save the command, output, and exit under `.postmaster/verify/`. | Exit non-zero. The failure is `tokenIdToHex("0x0")` returning `0x0` while the decimal spelling is padded. `git log` at the time of that transcript shows the regression commit and no product-fix commit. |
| AC2 | After the fix, that same focused regression test passes without weakening its assertion of the finding's expected behavior. | After the fix, run `pnpm exec vitest run <the same file>` again. | Exit 0. The test still asserts that both spellings equal `0x` plus 64 zeroes, and that `0xA`, `0xa`, and `10` share one padded lowercase form. The assertion was not changed to accept `0x0`, to accept the input unchanged, or to skip the equality check. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head after the fix, run `pnpm run test`. | Exit 0. |
| AC4 | The change set addresses only `W3-NAMES-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --format=%s 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The product diff is the regression plus the `tokenIdToHex` canonicalization for this finding. No other findings.md id is named as a bundled fix. No `InvalidTokenIdError`. No drive-by refactor. |
| AC5 | The pull request is opened against main from a branch named after this ticket, with no cherry-picks from testing-campaign required to explain the diff. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | The ancestor check exits 0. The commits that explain the diff are this ticket's own commits, not cherry-picks from testing-campaign. Opening the pull request is not the lane's to do: workhorses never push. The landing route opens it against main from branch `WEB-1662`. |

## Tasks

- [ ] T001 [P] [AC1] Add a focused regression under `test/` that calls `tokenIdToHex` with `"0"` and `"0x0"` and expects `0x` plus 64 zeroes, and with `"0xA"`, `"0xa"`, and `"10"` expecting one padded lowercase form. Run it on the main baseline and record the unpadded-`0x0` failure before any product fix.
- [ ] T002 [AC2] Change `tokenIdToHex` so those spellings share one padded lowercase representation. Do not weaken the assertion. Do not add `InvalidTokenIdError` or a uint256 range check.
- [ ] T003 [AC3] Run `pnpm run test` at the branch head and keep the passing result.
- [ ] T004 [AC4] Confirm the diff names no other findings.md id and contains no drive-by refactor.
- [ ] T005 [AC5] Confirm the branch is descended from main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a` and that no testing-campaign cherry-pick is required to explain the diff. Do not push.
