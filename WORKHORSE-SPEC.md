# Workhorse spec: WEB-1713 [W8-BUDGET-002] Fix testing-campaign finding on main (TDD)

> **Current tip:** metadata-only correction (25 commits including this tip;
> hash intentionally omitted — content predates own commit). Product
> unchanged since `964d536` (+71/−31 in `src/services/avatar.ts`).

## Summary

Add a request-deadline guard (`timeLeftForAttempt`) before `fetchMedia` in
`AvatarService.resolveMedia`, extended through 12 correction rounds with:
per-hop `beforeEachFetch` gating, `min(7000,remainingRequestTime())` bounded
signal timeout, causal `Promise.race` against signal-abort, named handler with
exact `removeEventListener` cleanup in `finally`, initial `signal.aborted`
guard, and late-rejection suppression.  Enforces invariant B1.

## Exact final scope (24 commits from BASE `5a5527c`)

| File | +/− |
|---|---|
| `WORKHORSE-SPEC.md` | +72 |
| `src/services/avatar.ts` | +71/−31 |
| `test/avatar-deadline.test.ts` | +384 |
| **Aggregate** | **+527/−31** |

Tests: 30 total (16 behavioral/lifecycle + 14 contract) in 384-line test file.

### Product invariants

1. Entry guard: `timeLeftForAttempt` before `fetchMedia`
2. Per-hop gating: `beforeEachFetch` → `timeLeftForAttempt` before every redirect
3. Bounded timeout: `AbortSignal.timeout(min(7000, remainingRequestTime()))`
4. Causal race: `Promise.race([work, abortPromise])`
5. Named handler: `abortHandler` with exact `removeEventListener` in `finally`
6. Initial-aborted: `signal.aborted` → RequestDeadlineError, no listener
7. Late-rejection suppression: `work.catch(() => {})`

### Test suite: 30 tests (16 behavioral + 14 contract)

**Behavioral (16):** entry guard, redirect hop (avatar+header), timeout ≤ remaining,
7s cap outside request, deadline-driven fetch, media-cap (avatar+header),
hanging body abort (avatar+header), unrelated fetch error, unrelated body error,
success cleanup (avatar+header), sync rejection, async signal-abort, 16 concurrent,
initial-aborted, 6999/7000/7001 boundaries.

**Contract (14):** dedup identical tuple, normalize capture, separate capture,
distinct callbacks, distinct signals, idempotent removal, pre-dispatch once
auto-removal, stopImmediatePropagation skip, post-abort+repeated abort,
post-abort+explicit remove, cross-signal removal, capture-specific removal,
stale-wrapper→non-once re-registration, duplicate once one invocation.

## Correction history

| R | Test commit | Fix commit | Finding |
|---|---|---|---|
| 1 | `4deeca1` | `1579f7e` | Entry guard |
| 2 | `59f8c13` | `f06611c` | Per-hop gating, bounded timeout, error conversion |
| 3 | `1a3896a` | `27a7536` | deadlineDriven, body coverage |
| 4 | `89b5c8c` | `af9dff5` | signal.aborted attribution |
| 5 | `78e811f` | `44d5ca0` | Causal race |
| 6 | `2a53b22` | `964d536` | Named handler, cleanup, initial-aborted |
| 7-12 | `aa5e7c6`→`c79bbae` | — | Test hardening only |
| repair | `4151e98`+`990adf5`+`c79bbae` | — | Revert+contract-red+harness-green |
| docs | this tip | — | Metadata correction (24-commit scope) |

**Sibling rewrite**: `760ff5c` amended into `4c152cc` (TS `{once}` fix).
Evidence on `760ff5c` inapplicable.  Product unchanged since `964d536`.

## Build/test/lint

- `pnpm run test`: 59 files, all pass
- `pnpm run typecheck`: Clean
- `pnpm run lint`: 0 errors