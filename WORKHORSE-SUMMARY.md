# WORKHORSE SUMMARY — WEB-1673

Implemented the registry-hierarchy totality fix for a definitive `NotFoundError` from the pre-service expiry check.

- `src/index.ts` now returns a root-first, zero-owner placeholder only when `checkExpiry()` definitively misses.
- The placeholder receives the normal hierarchy client cache policy and a 300-second edge copy.
- The hierarchy service is not called, and no public `_provenance` is emitted.
- Other hierarchy error paths remain unchanged.
- Added a focused route regression and package-name entrypoint coverage required by the run's library check.

Decision: the assigned lane branch is `WEB-1673-alpha`, which is ticket-named and was cut directly from the approved main baseline/spec commit. PR: https://github.com/ensdomains/metadata-service-v2/pull/66 (base `main`). The final verifier was run with `CI=1` so the existing `vitest` script exits after its successful run rather than entering local watch mode.

## Checks

- **Focused TDD baseline:** expected failure, status was 404 instead of 200 (`EXIT_CODE=1`).
- **Focused regression after fix:** passed (`1 passed`).
- **TypeScript:** `pnpm typecheck` passed.
- **Run verifier:** `CI=1 .../scripts/verify.sh run .` passed both checks:
  - gate: `pnpm run test` — 60 files passed, 1066 tests passed, 1 skipped.
  - library: package-name import test passed.

## Evidence

1. **AC1 — PASS:** `.postmaster/verify/ac1-baseline-failure.txt` records the focused regression failing with received status 404 before product commit `958361e`; the test-only commits precede the fix.
2. **AC2 — PASS:** `.postmaster/verify/ac2-focused-pass.txt` records the unchanged focused regression passing and exercising status, exact body, cache headers, edge write, no hierarchy call, and no `_provenance`.
3. **AC3 — PASS:** `.postmaster/verify/logs/gate.log` records the final project gate passing at branch head.
4. **AC4 — PASS:** `.postmaster/verify/ac4-scope.txt` records the BASE diff review; the product change is limited to the definitive expiry-precheck miss path and contains no implementation for another finding.
5. **AC5 — PASS:** `.postmaster/verify/ac5-history.txt` records the ticket-named branch, independent commit history, no testing-campaign references, and open PR #66 against `main`.

The required library-check transcript is `.postmaster/verify/logs/library.log`.
