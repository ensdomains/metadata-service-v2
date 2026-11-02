# Workhorse spec: WEB-1704 [W8-CACHE-003] Fix testing-campaign finding on main (TDD)

## Summary

A valid `NameRegistered` webhook must not report a completed purge when one exact endpoint-metadata delete fails. Processing fails with HTTP 500 so the delivery can be retried. Do that on main, test-first, for this finding only.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers, Vitest 2 under Node (see `package.json` and `vitest.config.ts`).
- **Dependencies used or added**: none added. Install with `pnpm install --frozen-lockfile` when `node_modules` is missing.
- **Testing**: a new focused regression via `pnpm exec vitest run <file>`; the project gate `pnpm run test`.
- **Constraints**: TDD from committed main `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-CACHE-003`. No cherry-pick or transplant from testing-campaign. No drive-by refactors. Workhorses do not push.

## Direction check

- TDD, failing regression recorded before any product fix: the new test is committed and run red on the main baseline before any commit that changes product code.
- Independent fix cut from main: every commit descends from the BASE above. Do not read other branches or `.worktrees/`.
- One finding only: the diff and commit messages name `W8-CACHE-003` and no other findings.md id.
- Out of scope, left out: image, batch, expiry, hierarchy, and edge-cache failure policy, except where a catch would hide this metadata deletion failure on the way to the webhook response.

## Structure

- A new focused test under `test/`, driving the webhook handler. The lane chooses the file name.
- Product change only on the path that deletes the exact endpoint-metadata keys and then reports webhook success. On main that path is `WebhookService` in `src/services/webhook.ts`: `invalidateMetadataCache` catches a delete rejection, and `handleWebhook` then returns 200 `processed: true`.
- `MetadataCacheService.invalidate` in `src/services/metadata-cache.ts` also catches a delete rejection. The webhook handler does not call it. `src/services/image-cache-coordination.ts` does not exist on main. Do not add it.
- `docs/webhook.md` only if a sentence would still say a partial metadata purge is success. Do not rewrite the doc.

## Decisions

1. The acceptance surface is the webhook handler response, not a private function's return type. `WebhookService.handleWebhook` is the interface the ticket describes: 200 `processed: true` versus HTTP 500 with no completed-purge claim. The lane chooses how a delete rejection reaches that response.
2. Changing only `MetadataCacheService.invalidate` does not meet the ticket. The webhook path does not call it, and the handler would still return 200. The webhook's own exact-key purge must fail the request. Making `MetadataCacheService.invalidate` surface the same failure is in scope only so the two exact-key purges do not disagree. It is not a substitute for the webhook response.
3. The exact key set is every `meta:${network}:${registryType}:${canonicalName}` for `SUPPORTED_NETWORKS` and registry types `registry` and `namewrapper`. For `red-team.eth` that is four keys today. The regression makes `meta:mainnet:registry:red-team.eth` reject and the other three succeed.
4. Purge success requires every key in that set to be deleted. A rejection is not success, even when the other deletes complete. Do not remove the rejected key by another path and then return 200. An in-request retry that still sees the rejection must still fail the webhook. The rejected key stays until a later delivery deletes it.
5. HTTP 500 is the existing internal-error status (`docs/webhook.md`). The body must not contain `processed: true`. Do not invent a new status. The handler's existing failure body, `{ error: "Internal server error" }`, is acceptable.
6. The route wrapper in `src/index.ts` already skips edge purge and warm unless the handler status is 2xx. Do not change that wrapper for this finding.
7. A valid `NameRegistered` webhook is one the handler would accept and process: `event_type` `NameRegistered`, well-formed name `red-team.eth`, a numeric `timestamp`, and either the service's existing unauthenticated dev acceptance or a correct HMAC signature. `NameRegistered` is not an expiry-affecting event. The 500 must come from the purge failure, not from 400, 401, or 503.
8. The regression must fail on the main baseline because the handler returns 200 `processed: true` while `meta:mainnet:registry:red-team.eth` was not deleted. Record that failing run before any product-code commit. After the fix, the same assertions pass. Do not weaken them.
9. The test must show the purge ran: the other three exact keys are deleted. A 500 that happens before any metadata delete does not count.
10. Workhorses do not push and do not open the pull request. The landing branch is `WEB-1704`, already cut from main at BASE. The workhorse branch is `wb/WEB-1704-<lane>`. Show that the workhorse commits descend from BASE and contain no cherry-pick from another branch.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On a commit that adds the test and does not change product code, run `pnpm exec vitest run <the new test file>`. Input: a valid `NameRegistered` webhook for `red-team.eth`; deletion of `meta:mainnet:registry:red-team.eth` rejects; the other three exact metadata deletions succeed. Save the command, output, and exit under `.postmaster/verify/` before the first commit that changes `src/`. | The command exits non-zero. The failure shows HTTP 200 and/or `processed: true` instead of HTTP 500 with no completed-purge claim. The rejected key is still present. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | The same `pnpm exec vitest run <the new test file>` on the final code. The test still asserts HTTP 500, the body does not have `processed: true`, `meta:mainnet:registry:red-team.eth` is still present, and the other three exact keys were deleted. | Exit 0. The assertions are the same ones that failed in AC1. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `/Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` just before writing the summary. | The gate check passes. Record the library check as verify.sh prints it. A library result of not-run is not a failure to paper over with a new package-name import. |
| AC4 | The change set addresses only `W8-CACHE-003` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | Only this finding's regression and the minimal purge-failure fix, plus the spec already committed in the worktree. No other findings.md id in the diff or messages. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`; `git log --format=%B 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. | The ancestor check exits 0. The messages have no cherry-pick trailer and do not import testing-campaign commits. Do not push. |

## Tasks

- [ ] T001 [P] [AC1] Add the focused failing regression under `test/` and record its failing run before any product change.
- [ ] T002 [AC1] [AC2] Make a rejected exact endpoint-metadata delete fail the webhook with HTTP 500 and no `processed: true`, without deleting the rejected key by another path.
- [ ] T003 [AC2] Re-run the same focused test and keep the assertions unchanged.
- [ ] T004 [AC3] Run the recorded checks at the branch head.
- [ ] T005 [AC4] [AC5] Confirm the diff is only this finding and descends from main with no cherry-pick. Do not push.
