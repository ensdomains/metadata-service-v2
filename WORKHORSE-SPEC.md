# Workhorse spec: WEB-1705 [W8-WEBHOOK-009] Fix testing-campaign finding on main (TDD)

## Summary

A validly signed webhook envelope whose timestamp is 121 seconds old is accepted when `toleranceSecs` is `NaN`. That value is what `parseInt` returns for a malformed non-empty `WEBHOOK_TOLERANCE_SECS`. `NaN ?? 120` stays `NaN`, and `Math.abs(nowSecs - ts) > NaN` is always false, so the documented 120-second replay window never rejects the envelope. The handler returns 200 and deletes six internal cache keys, then the rest of the purge path runs.

A non-finite override must not disable that window. This run falls back to the documented default of 120 seconds. The stale envelope returns 401 before any purge or warm side effect. A finite override is still honored. This is a TDD fix on committed main, for `W8-WEBHOOK-009` only.

## Technical context

- **Language and version**: TypeScript on Cloudflare Workers (Hono). Node 22 is the local runtime.
- **Dependencies used or added**: none. Use the webhook service and test tools the repo already has.
- **Testing**: focused regression `CI=true pnpm exec vitest run test/webhook-replay-tolerance.test.ts`; project gate `CI=true pnpm run test`. Recorded checks are run with `CI=true` set in the environment.
- **Constraints**: cut from committed main at `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`. One finding, `W8-WEBHOOK-009`. No cherry-pick, copy, or transplant from `testing-campaign` or any other branch. No other findings. No drive-by refactors.

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: failing regression first, recorded before any product fix | The first product commit adds only `test/webhook-replay-tolerance.test.ts` and the failing transcript under `.postmaster/verify/`. Run that file and keep the transcript before any later commit changes `src/`. |
| Fix only after the failing run is recorded | The product fix is a later commit. The assertion text is not edited after it has failed for the right reason. |
| Same focused test passes after the fix, assertion not weakened | Re-run the same file. The expectations from the failing run are still the ones that pass. |
| `pnpm run test` passes at the ticket branch head | Finite form `CI=true pnpm run test` exits 0 at the lane head. |
| One finding only | The diff touches the replay-tolerance wiring and this new test, nothing filed under another findings id. |
| No cherry-picks from testing-campaign | Every line is written in this worktree. Do not read other branches or `.worktrees/`. |
| Independent PR against main from a ticket-named branch | Lane commits stay on the lane branch already checked out. The run lands them on `WEB-1705`, which is the ticket-named branch cut from main. The lane does not push and does not open the pull request. |

## Structure

| File | Change |
|---|---|
| `test/webhook-replay-tolerance.test.ts` | New focused regression. Does not edit the existing webhook suites. |
| `src/services/webhook.ts` | A non-finite `toleranceSecs` must not be used as the replay window. |
| `src/index.ts` | A malformed, excessively large, or non-safe-integer `WEBHOOK_TOLERANCE_SECS` must not be passed through. Whole-string digit validation, safe-integer guard, and a documented maximum of 86400 seconds. |

No other files. A lane that can meet both requirements without a new helper may leave the shape as it is. Do not add a dependency. Do not change signature verification, payload validation, body size, auth, or any other finding.

## Complexity tracking

None. The ticket's direction is met as stated.

## Decisions

1. **Fallback, not fail-closed.** The invariant is that an invalid override must not disable the default 120-second window. The ticket allows fallback or fail-closed. This spec chooses fallback: a non-finite `toleranceSecs` is treated as unset, and the documented default of 120 seconds applies. A typo must not take a valid fresh webhook offline, and it must not accept a 121-second-old signed envelope. Fail-closed is rejected because it would 401 a fresh envelope for a config typo, which is more than the invariant asks.

2. **What is non-finite.** `NaN`, `Infinity`, and `-Infinity`. The minimized input is `toleranceSecs: NaN`, produced by `parseInt` of a malformed non-empty env value such as `abc`, `NaN`, or a whitespace-only string. `Infinity` has the same comparison hole (`> Infinity` is false) and is the same defect, not a second finding. A finite number, including `0` and a negative number, is still an override. Do not change how finite overrides are interpreted. An empty or missing env value already means unset; leave that path as it is.

3. **Both layers.** The service must reject the minimized input even when a caller passes `toleranceSecs: NaN` directly. The env wiring must not forward a non-finite `parseInt` result. Fixing only the wiring leaves the service hole the ticket names. Fixing only the service leaves production still constructing `NaN`. Both change.

4. **The observable.** A valid HMAC-signed `NameRegistered` envelope for `stale-window.eth`, timestamp 121 seconds before now, with `toleranceSecs: NaN`, returns 401. Internal cache deletes do not run (baseline runs six). Metadata, batch, and image purge do not run. The route warms only on 2xx, so a 401 does not warm. The signature must be valid over that stale timestamp, so the baseline failure is 200 plus the six deletes, not a 401 from a bad signature. Exactly 120 seconds remains inside the window, because the comparison is strict. A fresh signed envelope with `toleranceSecs: NaN` still returns 200 and still purges, which shows the fallback is the default window and not a closed gate. A finite override of 300 seconds still accepts 121 seconds and still rejects 1000 seconds, as the existing suite already covers a finite window.

5. **The focused test file** is `test/webhook-replay-tolerance.test.ts`. It drives `WebhookService.handleWebhook` with a real HMAC, not the unauthenticated dev hatch. It must fail on the unmodified baseline because the stale `NaN` envelope is accepted and the six deletes run, not because of an import error or a watch-mode hang.

6. **The gate is finite.** `package.json` `test` is `vitest`, which stays in watch mode unless CI is set. GitHub Actions sets CI. The showing commands export `CI=true` so the same script exits. That is the project gate, not a different suite.

7. **Landing.** The lane does not push and does not open a pull request. No commit is a cherry-pick. The ticket branch that will target main is `WEB-1705`.

8. **Maximum accepted tolerance.** A `WEBHOOK_TOLERANCE_SECS` value that parses to a non-safe-integer (`Number.isSafeInteger` → false) or exceeds the documented maximum of 86400 seconds (24 hours) is treated as unset and falls back to the secure 120-second default. This supersedes Decision 2's "a finite number is still an override" for values exceeding the maximum; ordinary finite overrides including 0, 300, and 86400 remain honored. The env parser rejects non-safe-integers to close the `parseInt` precision gap (e.g., `"999999999999999999999"` → `1e+21`, a non-safe-integer). This constraint was added by external security review (round 2, P2): a digit-only huge value passes the whole-string regex but still disables replay protection.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit. | On the commit that adds only `test/webhook-replay-tolerance.test.ts`, run `CI=true pnpm exec vitest run test/webhook-replay-tolerance.test.ts`. Input: a valid HMAC-signed `NameRegistered` body for `stale-window.eth`, timestamp 121 seconds old, `toleranceSecs: NaN`. Save the transcript, including the command, the output, and the exit code, under `.postmaster/verify/` before any commit that changes `src/`. | Exit non-zero. The failure is status 200 and six internal cache deletes, not an import error, a syntax error, or a hang. The signature was valid. |
| AC2 | After the fix, that focused regression passes without weakening its assertion. | `CI=true pnpm exec vitest run test/webhook-replay-tolerance.test.ts` on the fix commit. The assertions are the ones that failed in AC1. | Exit 0. The 121-second envelope with `NaN` returns 401 and does not purge or warm. A fresh envelope with `NaN` still returns 200 and still purges. A finite override is unchanged. `git diff` of the test file against the AC1 commit shows no relaxed expectation. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head. | `CI=true pnpm run test` at the lane head, after AC2 is green. Then `CI=true /Users/davidchu/.postmaster/tool-pins/0620bfc90eb32a35124279d9780df42174e6ccd9/scripts/verify.sh run .` | Exit 0. The suite finishes; it is not left in watch mode. |
| AC4 | The change set addresses only `W8-WEBHOOK-009` and does not bundle another findings.md id. | `git diff --stat 5a5527c7e7ac7c20140bdd81757c5bd075bd389a...HEAD` and `git log --oneline 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD` | Only the new tolerance test and the non-finite replay-window fix in the webhook wiring. No other finding id in the diff or the commit messages. |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign. | `git status -sb`, `git merge-base --is-ancestor 5a5527c7e7ac7c20140bdd81757c5bd075bd389a HEAD`, and `git log --format='%H %s' 5a5527c7e7ac7c20140bdd81757c5bd075bd389a..HEAD`. Do not push. | The lane branch contains only fresh commits descended from that base. No cherry-pick. The pull request is not opened by the lane; the run lands the change on `WEB-1705`, which targets main. |

## Tasks

- [ ] T001 [P] [AC1] Add `test/webhook-replay-tolerance.test.ts`. Drive `WebhookService.handleWebhook` with one HMAC-signed `NameRegistered` envelope for `stale-window.eth` at a timestamp 121 seconds old and `toleranceSecs: NaN`. Assert status 401 and that the six internal cache deletes, and the other purge calls, do not run. Include a fresh timestamp with `NaN` that still purges, and a finite override that still means what it means today. Run the focused command, save the failing transcript under `.postmaster/verify/`, and commit the test and that transcript before changing `src/`.
- [ ] T002 [AC2] [AC4] Treat a non-finite `toleranceSecs` as unset so the documented 120-second window applies, and do not pass a non-finite `parseInt` of `WEBHOOK_TOLERANCE_SECS` into the service. Do not change finite overrides, signature checks, payload validation, or auth. Do not copy another branch.
- [ ] T003 [AC2] [AC3] Re-run the focused file without editing its assertions, then run `CI=true pnpm run test` and the recorded checks. Commit the fix and the passing transcripts.
- [ ] T004 [AC4] [AC5] Confirm the diff is only this finding, the commits are fresh and descended from `5a5527c7e7ac7c20140bdd81757c5bd075bd389a`, and nothing was pushed.
