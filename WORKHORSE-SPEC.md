# Workhorse spec: WEB-1714 [W8-D1-001] Fix testing-campaign finding on main (TDD)

## Summary

Fix the `registry_hierarchy` table's primary key so that storing one root domain's
hierarchy no longer corrupts a sibling root that shares an ancestor. The root cause is
`PRIMARY KEY (network, id)` which makes `INSERT OR REPLACE` move a shared ancestor row
from one root to another. The fix changes the PK to `(network, id, root_domain_id)` via a
new migration, so each domain owns its own copy of ancestor rows and `getHierarchy`
consistently returns the intact root-first hierarchy.

## Technical context

- **Language and version**: TypeScript, Cloudflare Workers runtime
- **Dependencies used or added**: none
- **Testing**: `pnpm run test` (vitest); new test uses `node:sqlite` (real SQLite) following
  the project's existing `test/d1-canonical-name.test.ts` pattern
- **Constraints**: one finding only (W8-D1-001); no cherry-picks from testing-campaign;
  strict TDD from main base; the change set must not bundle other findings

## Direction check

| Constraint | How this plan meets it |
|---|---|
| TDD: failing test first, then fix | Write the regression test on the current schema (main base), run it to confirm it fails, commit the red test; then add the migration and rerun to confirm green |
| One finding only (W8-D1-001) | The only change is the new migration and the regression test; no other files touched |
| Independent PR from main | Branch `WEB-1714` cut from BASE `5a5527c`; no cherry-picks from testing-campaign |
| Gate `pnpm run test` passes at branch head | The migration is backwards-compatible with existing D1 code; the new test is the only addition |

## Structure

| File | Action |
|---|---|
| `migrations/003_hierarchy_root_scoping.sql` | Create: drop and recreate `registry_hierarchy` with `PRIMARY KEY (network, id, root_domain_id)` |
| `test/d1-hierarchy-isolation.test.ts` | Create: regression test using real SQLite that stores two hierarchies sharing `eth` as ancestor and verifies both read back intact |

## Complexity tracking

No departures from the ticket direction. The fix is exactly what the invariant demands:
`(network, id)` → `(network, id, root_domain_id)` in the schema, with no application-code
changes needed (the existing `DELETE WHERE root_domain_id` + `INSERT OR REPLACE` pattern
works correctly when the PK includes `root_domain_id`).

## Decisions

1. **Schema migration vs. application-code workaround**: A code-only fix (e.g., switching to
   `INSERT OR IGNORE` or conditional upsert) would leave the schema modelling the wrong
   invariant — that a name can only belong to one root. The schema fix captures the
   domain's actual cardinality: one name can be an ancestor of many roots. A migration is
   safe because D1 is a regenerable cache, and `DROP TABLE IF EXISTS` + `CREATE TABLE` is
   the project's established pattern (`002_network_scoping.sql` does the same).

2. **New migration (003) vs. editing 002_network_scoping.sql**: A new migration keeps the
   change minimal and targeted. Editing 002 would silently change an already-applied
   migration's semantics. The new migration follows the project's existing naming
   convention.

3. **No application-code changes**: The existing `storeHierarchy` implementation —
   `DELETE WHERE root_domain_id = ?` then `INSERT OR REPLACE` per level — is correct once
   the PK distinguishes rows by `root_domain_id`. The DELETE clears the domain's old rows;
   the INSERT OR REPLACE no longer collides with another domain's ancestor rows.

## Showing each criterion

| # | Criterion, as the ticket words it | Check (command and input) | Expected output |
|---|---|---|---|
| AC1 | A new focused regression test on a branch cut from main fails on the main baseline as described, and that failing run is recorded before any product fix commit | Run the isolated regression test on the baseline schema (002 only): store `a.eth` as `[eth, a.eth]`, store `b.eth` as `[eth, b.eth]`, read `a.eth`. Captured as a commit on the branch before the migration is applied. | `getHierarchy("a.eth")` returns only `[a.eth]` — the `eth` row was stolen by `b.eth`'s write. Test fails with the expected assertion error. |
| AC2 | After the fix, that focused regression passes without weakening its assertion | Apply migration 003, rerun the same test | `getHierarchy("a.eth")` returns `[eth, a.eth]` — the intact root-first hierarchy. `getHierarchy("b.eth")` returns `[eth, b.eth]`. Test passes. |
| AC3 | The project gate `pnpm run test` passes at the ticket branch head | `pnpm run test` | Exit 0; all existing tests plus the new test pass |
| AC4 | The change set addresses only W8-D1-001 and does not bundle another findings.md id | `git diff BASE...HEAD --stat` | Only `migrations/003_hierarchy_root_scoping.sql` and `test/d1-hierarchy-isolation.test.ts` changed |
| AC5 | The pull request targets main from a ticket-named branch, with no cherry-picks from testing-campaign | `git log --oneline BASE..HEAD` and `git branch --show-current` | Branch is `WEB-1714`; all commits are authored on this branch from BASE; no testing-campaign commits present |

## Tasks

- [ ] T001 [P] [AC1] Write `test/d1-hierarchy-isolation.test.ts` with the shared-ancestor regression test using real SQLite, run it to confirm it fails on the current schema, and commit the failing test
- [ ] T002 [P] [AC2] Create `migrations/003_hierarchy_root_scoping.sql` with `PRIMARY KEY (network, id, root_domain_id)`, rerun the regression test to confirm it passes
- [ ] T003 [AC3] Run `pnpm run test` to confirm full gate passes
- [ ] T004 [AC4,AC5] Verify diff scope and branch provenance

---

## Completion note (post-implementation, 4 external-review rounds)

The original plan assumed no application-code changes would be needed. External
review across 4 rounds identified additional work, all within W8-D1-001 scope:

### Actual change set (6 files, +681/−12 from BASE 5a5527c)

| File | Purpose |
|---|---|
| `WORKHORSE-SPEC.md` | This spec (planning intent) |
| `migrations/003_hierarchy_root_scoping.sql` | PK `(network, id, root_domain_id)` + composite index `idx_hierarchy_root_level (network, root_domain_id, level)` |
| `src/services/d1.ts` | `getHierarchyCount()` with freshness filtering; per-root `sync_version` subquery |
| `src/services/metadata.ts` | `executionCtx` param on `getRegistryHierarchy`; post-try-catch recovery on both success and failure paths |
| `src/index.ts` | Pass `c.executionCtx` from hierarchy route |
| `test/d1-hierarchy-isolation.test.ts` | 18 tests: isolation, EXPLAIN QUERY PLAN, freshness count, cross-network, recovery on both paths, sync_version per-root, boundary parity, causal containment, rejection absorption, deferred persistence |

### Rounds

- **Round 1** (a5e5981→b3deba6): PK fix + regression test
- **Round 2** (ad9f5bb→fe9cfa9): Composite index + catch-block route recovery
- **Round 3** (b1da4d0→1449252): Post-try-catch recovery on both paths, freshness-filtered count
- **Round 4** (1c3b66e→a4a3dca): Full-PK sync_version subquery, inclusive count boundary, lint-clean

### Final gate

59 files, 1082 passed, 1 skipped. Typecheck 0, lint 0 errors. EXPLAIN QUERY PLAN: `SEARCH USING INDEX idx_hierarchy_root_level (network=? AND root_domain_id=?)`.