# Workhorse spec: WEB-1695 [W8-CACHE-001] Fix testing-campaign finding on main (TDD)

## Summary

Name-keyed cache keys currently lowercase the name and do not apply NFC, so the equivalent spellings `"É.eth"` (NFC) and `"E\u0301.ETH"` (NFD) do not share a hierarchy entry on mainnet. The webhook purge already canonicalizes to NFC + lowercase, then deletes that canonical key, and therefore cannot remove the distinct NFD entry the read path wrote.

Make every name-keyed cache-key boundary use the canonical NFC + lowercase name, so those two spellings share `ensnode:mainnet:hierarchy:é.eth` and the existing purge deletes the entry the read path wrote. Ship it as a TDD fix cut from committed main: a focused regression that fails on this baseline, recorded before any product change, then the smallest fix that makes that same assertion pass.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers (this repo's existing toolchain; no new runtime)
- **Dependencies used or added**: none
- **Testing**: `pnpm exec vitest run test/cache-name-canonicalization.test.ts` for the focused regression; `pnpm run test` for the project gate (vitest watches on a TTY, so run it so it exits)
- **Constraints**: TDD on this BASE only; one finding (`W8-CACHE-001`); no cherry-pick or transplant from testing-campaign; no other findings id; no drive-by refactor

## Direction check

- TDD, failing regression first. The first product-touching commit adds only the regression. Its failing run (command, output, non-zero exit) is saved under `.postmaster/verify/` before the fix commit exists. The fix commit comes after that record.
- Cut from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. Do not read, copy, cherry-pick, or transplant testing-campaign code or tests. Author every line on this branch.
- One finding only. The diff addresses `W8-CACHE-001` and does not mention or bundle another findings id.
- Minimal fix. Change the name-keyed key boundary so equivalent spellings share a key. Do not restructure caching, TTLs, webhook auth, or unrelated key schemes.
- The pull request is not opened by the workhorse. Do not push. The ticket-named branch is `WEB-1695`, targeting main, assembled at landing. This lane's job for that criterion is ancestry evidence: the branch is cut from BASE and contains no cherry-pick.
- No project context file. README.md and docs/webhook.md are the docs that constrain this change. docs/webhook.md already says invalidation is for the canonicalized name. This fix makes the key builders agree with that.

## Structure

- `test/cache-name-canonicalization.test.ts` — new focused regression. Create this file; do not bury the regression in an unrelated suite.
- `src/services/cache.ts` — the name-keyed key boundary (`CacheKeys`). This is the expected product change.
- Do not expect to change `src/services/metadata.ts` or `src/services/webhook.ts`. On this BASE the hierarchy read already calls `CacheKeys.hierarchy(name, network)` and the purge already canonicalizes, then calls `CacheKeys`. A call-site-only change that leaves `CacheKeys.hierarchy("E\u0301.ETH", "mainnet")` distinct does not meet the expected key. Touch those files only if a check proves the shared key still diverges, and say why in the summary.

## Complexity tracking

None. The plan does not depart from the ticket's direction.

## Decisions

- The waybill's line numbers do not match this BASE. `CacheKeys` is the name-keyed boundary in `src/services/cache.ts`. The hierarchy read seam is `MetadataService.getRegistryHierarchy`, which calls `CacheKeys.hierarchy`. The purge seam is `processWebhookEvent`, which canonicalizes the event name and then deletes `CacheKeys.hierarchy`. Do not edit `getBatchMetadata` just because the waybill's line range lands there on this BASE.
- Canonical form is the form `canonicalizeName` already defines: NFC, then lowercase. It is idempotent. Prefer calling that function from the key boundary rather than inventing a second normalizer. Inlining the same two operations is acceptable only if the resulting keys match `canonicalizeName`. The check is the key string, not the import.
- The invariant covers every name-keyed `CacheKeys` builder, not only hierarchy: `domain`, `domains`, `migrationStatus`, and `hierarchy`. The ticket's minimized proof is the hierarchy key. The regression must assert that proof and the same identity for the other three builders. `metadata-cache` and `image-cache` already canonicalize; leave them alone.
- `domains` keeps its current shape: canonicalize each name, then sort, then join. Do not add deduplication. A one-name batch of either spelling is `ensnode:mainnet:batch:é.eth`. A two-name batch of the two spellings is `ensnode:mainnet:batch:é.eth,é.eth`.
- The NFD input in tests is the source string `"E\u0301.ETH"`, not a precomposed character. The expected hierarchy key is the literal `ensnode:mainnet:hierarchy:é.eth` (U+00E9), not merely "the two keys are equal".
- The regression file is `test/cache-name-canonicalization.test.ts`. The focused command is `pnpm exec vitest run test/cache-name-canonicalization.test.ts`.
- Network is not special-cased. The ticket's input is mainnet. The same builders serve sepolia; a mainnet-only branch inside the key function is a wrong fix.
- Opening the pull request is landing's job, not the lane's. AC5 is shown by local git evidence. Do not push.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On the commit that adds only `test/cache-name-canonicalization.test.ts`, run `pnpm exec vitest run test/cache-name-canonicalization.test.ts`. Input inside that test: `"É.eth"` and `"E\u0301.ETH"` on mainnet. Save the command, output, and exit under `.postmaster/verify/` before creating the fix commit. | Exit non-zero. The new assertion fails because the NFD hierarchy key is not `ensnode:mainnet:hierarchy:é.eth` (it is the distinct lowercase-NFD key). The transcript exists before the fix commit, and `git log` shows the test-only commit as an ancestor of the fix commit. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | On the fix commit, run `pnpm exec vitest run test/cache-name-canonicalization.test.ts` again. Diff the test file against the test-only commit. | Exit 0. Both hierarchy keys are `ensnode:mainnet:hierarchy:é.eth`. The assertion text is unchanged from the failing commit. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | At the branch head, run `pnpm run test` so vitest exits (non-TTY, or `CI=1 pnpm run test`). | Exit 0. |
| AC4 | The change set addresses only `W8-CACHE-001` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git diff 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` | Only the new regression and the name-keyed key boundary. No other findings id appears in the diff. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD` and `git log --format='%H %s' 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push. Do not open a pull request. | The ancestor check exits 0. Every commit is freshly authored on this branch (no cherry-pick trailer). The ticket-named branch `WEB-1695` and the pull request against main are landing's, not this lane's. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/cache-name-canonicalization.test.ts` asserting that `CacheKeys.hierarchy("É.eth", "mainnet")` and `CacheKeys.hierarchy("E\u0301.ETH", "mainnet")` are both `ensnode:mainnet:hierarchy:é.eth`, and that `domain`, `migrationStatus`, and `domains` give the same NFC + lowercase identity for those spellings. Commit only that test. Run the focused command and save the failing transcript under `.postmaster/verify/` before any product fix commit.
- [ ] T002 [AC2] [AC4] Make the name-keyed `CacheKeys` builders use NFC + lowercase, so the recorded assertion passes without editing it. No other finding, no drive-by refactor.
- [ ] T003 [AC2] [AC3] [AC5] Rerun the focused test, then `pnpm run test`, and record the ancestry evidence. Do not push.
