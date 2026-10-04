# Workhorse spec: WEB-1716 [W8-CACHE-004] Fix testing-campaign finding on main (TDD)

## Summary

The R2 image tier must stop serving a card after its status-specific lifetime, not merely attach HTTP metadata that cannot expire binding reads. The fix adds an age check on R2 objects before serving them from L2, so expired objects fall through to L3 origin generation. Strict TDD: the regression test fails on the main baseline first, then the minimal fix makes it pass.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime
- **Dependencies used or added**: None
- **Testing**: `pnpm run test` (vitest); focused regression test in `test/image-cache.test.ts`
- **Constraints**: One finding only (W8-CACHE-004); no cherry-picks from testing-campaign; independent PR from main; fix must not weaken existing assertions

## Direction check

- **One-finding scope**: The change set addresses only the R2 age check and the test that proves it. No other finding, no drive-by refactor.
- **Main-base isolation**: Branch cut from committed main at `5a5527c7`, no testing-campaign code copied or cherry-picked.
- **Strict TDD**: The focused regression test is written and recorded failing before any product fix commit.
- **Independent PR**: Targets main from `WEB-1716`, no dependency on testing-campaign.

## Structure

Files changed:

- `src/utils/storage.ts`: `getSvgByKey` gains an optional `maxAgeSeconds` parameter; when the R2 object's uploaded timestamp is older than this threshold, the method returns `null` (cache miss) instead of the expired bytes
- `src/services/image-cache.ts`: L2 R2 lookup passes `ttlConfig.r2MaxAge` to `getSvgByKey`, and the backfill path stays unchanged (an expired object is never read, so it is never backfilled)
- `test/image-cache.test.ts`: One new focused regression test: KV miss, R2 object present but older than `r2MaxAge` → falls through to L3 origin, returns fresh SVG with `cacheStatus: 'miss'`

No README change is needed — the README's statement "the KV and R2 tiers use migration-aware, stale-while-revalidate TTLs" was the promise; the code now keeps it. An accurate statement needs no edit.

## Decisions

- **Where to put the age check**: In `storage.ts` `getSvgByKey`, as an optional `maxAgeSeconds` parameter. This keeps the storage layer responsible for its own TTL enforcement rather than leaking R2 metadata details into the cache service. The alternative — checking in `image-cache.ts` — would need two R2 calls (head + get) or a new storage method.
- **Default behavior**: When `maxAgeSeconds` is not passed, `getSvgByKey` returns the object regardless of age (backward-compatible). The image cache service always passes its TTL-aware value.
- **Backfill path unchanged**: Since an expired R2 object is never read, the backfill that writes the stale data into KV with a fresh `createdAt` cannot fire. No change to `writeKv` or `writeBackAll`.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit | `pnpm run test -- --run test/image-cache.test.ts` on the branch after adding the regression test but before the product fix commit | The new regression test fails with output showing the expired R2 object was served as `stale` instead of falling through to origin |
| AC2 | After the fix, that focused regression passes without weakening its assertion | `pnpm run test -- --run test/image-cache.test.ts` on the branch after the product fix commit | The new regression test passes; all existing image-cache tests still pass |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head | `pnpm run test` | Exit 0, all tests pass |
| AC4 | The change set addresses only `W8-CACHE-004` and does not bundle another findings.md id | `git diff 5a5527c7...HEAD --stat` | Only `src/utils/storage.ts`, `src/services/image-cache.ts`, `test/image-cache.test.ts` changed |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign | Verify branch name is `WEB-1716` and no commit originates from testing-campaign | Branch `WEB-1716`, all commits authored in this run |

## Tasks

- [ ] T001 [P] [AC1] Add focused regression test to `test/image-cache.test.ts`: mock KV miss, mock R2 object with `uploaded` timestamp older than unmigrated `r2MaxAge` (3600s), assert `cacheStatus` is `'miss'` (not `'stale'`) and the returned SVG is freshly generated
- [ ] T002 [P] [AC2] [AC4] Modify `src/utils/storage.ts` `getSvgByKey` to accept optional `maxAgeSeconds` and return `null` when the R2 object's `uploaded` timestamp exceeds it
- [ ] T003 [P] [AC2] [AC4] Modify `src/services/image-cache.ts` L2 lookup to pass `ttlConfig.r2MaxAge` to `getSvgByKey`
- [ ] T004 [AC3] Run `pnpm run test` and verify all tests pass