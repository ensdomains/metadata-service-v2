# WORKHORSE-SPEC: WEB-1718 — W8-RASTER-001

## Summary

Fix a rasterize-dimension validation bug where `parseInt` silently accepts
malformed query parameters (`w=100a` → `100`), allowing an attacker to choose
arbitrary dimensions when the documented behaviour says non-pure-decimal values
should be ignored and the defaults used instead.

## Finding

- **ID:** W8-RASTER-001
- **Location:** `src/index.ts` lines 1094–1101 (rasterize route handler)
- **Confirmation:** `GET /mainnet/registry/raster-query.eth/rasterize?w=100a&h=101`
  currently accepts `width=100`; the spec (README.md:118) says `?w=`/`?h=` are
  ignored unless both are within 100–2000.

## Root cause

`parseInt('100a', 10)` returns `100` — it parses a leading integer and discards
trailing garbage. The rasterize handler uses `parseInt` on the raw query values
without validating that the entire string is a pure decimal integer. The image
route (`/image`) has the same pattern (line 555) but that is out of scope for
this ticket (W8-ROUTES-002, also WEB-1717).

Two downstream paths are affected:
- **Square custom size:** `hasCustomSize` is true and `outputWidth === outputHeight`;
  the handler bypasses `options.size` and rewrites the root SVG width/height
  attributes directly with the attacker-supplied values via `svgForRasterize.replace()`.
- **Non-square custom size:** `hasCustomSize` is true and dimensions differ;
  the handler sets `options.size = {width, height}` and passes it through
  `validateOptions` (which accepts the parsed integer) and into
  `imageCacheService.getImage()`. The SVG is not rewritten — the size is
  communicated to the card composer via options.

## Acceptance contract

The rasterize route supplies a custom size **only** when both `?w=` and `?h=`
are present, each is a pure decimal string (all digits, no sign, no whitespace,
no radix prefix), and each parsed value is within 100–2000 inclusive.
Otherwise — malformed values, missing or incomplete pairs, or out-of-range values —
no custom size is supplied and the defaults (518×518) are used.

Leading-zero decimal spellings (e.g. `w=0100`) are pure decimal strings and are
accepted; `parseInt('0100', 10)` → `100` correctly.

## Implemented fix

```typescript
// src/index.ts lines 1092-1097 (committed at 1cb8b19)
const statusParam = c.req.query('status');
const wParam = c.req.query('w');
const hParam = c.req.query('h');
const outputWidth = wParam && /^\d+$/.test(wParam) ? parseInt(wParam, 10) : null;
const outputHeight = hParam && /^\d+$/.test(hParam) ? parseInt(hParam, 10) : null;
```

Query params are captured once per dimension into locals (`wParam`, `hParam`)
before validation. The `/^\d+$/` regex rejects non-digit characters (`100a`,
`10.5`, `-100`, `0x64`, ` 200`) and empty strings. Leading zeros (`0100`) are
accepted — they match `\d+` and `parseInt` correctly converts them.

No change to `/image` or any other route. The fix is isolated to the
query-param parsing in the rasterize handler.

## Commit history

```
current metadata-only correction (tip; hash intentionally omitted because
    content predates commit)
de4b131 docs: correct WORKHORSE-SPEC mutant kill lists, per-file diffs, commit count
00f6f51 docs: correct WORKHORSE-SPEC to match committed matrix
ceec071 test: add non-square valid and exactly-one-invalid cases
1cb8b19 refactor: read rasterize w/h params once per dimension
ee9dee7 test: harden W8-RASTER-001 matrix
7920201 fix: W8-RASTER-001
c40e4e5 test: red — W8-RASTER-001 six-case TDD matrix on main base
23d3d9f spec: amend WORKHORSE-SPEC
4f152f9 spec: WORKHORSE-SPEC for W8-RASTER-001
5a5527c Merge pull request #54 (main BASE)
```

10 linear commits including current tip on
`5a5527c7e7ac7c20140bdd81757c5bd075bd389a`.

## Test matrix (20 cases)

All tests live in a dedicated `describe('rasterize dimensions (W8-RASTER-001)')`
block in `test/rasterize-svg-avatar.test.ts`. The block has its own `beforeEach`
that resets `state.card` (default 518×518 no-avatar card), `state.rasterized`,
`state.getImageOptions`, and console error spy.

The mock `ImageCacheService.getImage` captures its `options` argument into
`state.getImageOptions`, enabling assertions on whether `options.size` was set
(non-square path) or not (default path). The mock `RasterizeService.rasterize`
captures the SVG handed to the rasterizer into `state.rasterized`, enabling
assertions on root SVG width/height attributes (square rewrite path).

### Malformed values (T1–T3)

Square malformed pairs use **anchored root SVG assertions** to detect the SVG
attribute rewrite. Non-square uses **`getImageOptions` property assertions**
to detect whether `options.size` was set.

| Case | Query | Detection path | Red on base | Green after fix |
|------|-------|---------------|-------------|-----------------|
| T1 | `w=100a&h=100` | Square rewrite | SVG `width="100"` (rewritten) | SVG `width="518"` (default) |
| T2 | `w=200&h=200b` | Square rewrite | SVG `width="200"` (rewritten) | SVG `width="518"` (default) |
| T3a | `w=100a&h=101b` | Non-square `options.size` | `size={width:100,height:101}` | No `size` property |
| T3b | `w=150x&h=150x` | Square rewrite | SVG `width="150"` (rewritten) | SVG `width="518"` (default) |

Assertions: `not.toMatch(/^<svg width="ATK"/)` (anchored to root SVG opening tag,
distinct from background `<rect width="518">`) plus `toMatch(/^<svg width="518" height="518"/)`
for defaults; `not.toHaveProperty('size')` for non-square.

### Incomplete pairs (T4)

| Case | Query | Assertion |
|------|-------|-----------|
| T4a | `?h=200` | Root SVG 518×518, no `size` in options |
| T4b | `?w=200` | Root SVG 518×518, no `size` in options |

Both directions covered. Green on base already — guards against future
regression that tries to supply a one-param size.

### Clean custom sizes — square + non-square (T5)

| Case | Query | Detection path | Assertion |
|------|-------|---------------|-----------|
| T5a | `w=250&h=250` | Square rewrite | Root SVG `width="250" height="250"` |
| T5b | `w=200&h=300` | Non-square `options.size` | `size={width:200,height:300}`, root SVG 518×518 |
| T5c | `w=100&h=2000` | Non-square `options.size` (kills square-only) | `size={width:100,height:2000}`, root SVG 518×518 |
| T5d | `w=2000&h=100` | Non-square `options.size` (kills square-only) | `size={width:2000,height:100}`, root SVG 518×518 |

Non-square cases assert `getImageOptions!.size` has the exact expected shape.
The root SVG stays at 518×518 because the mock returns the default card and
the SVG rewrite only fires for square sizes.

### Boundary values (T6)

| Case | Query | Meaning | Assertion |
|------|-------|---------|-----------|
| T6a | `w=99&h=99` | Both below lower | Root SVG 518×518, no size |
| T6b | `w=100&h=100` | Exact lower bound (kills `>100`) | Root SVG `width="100" height="100"` |
| T6c | `w=2000&h=2000` | Exact upper bound | Root SVG `width="2000" height="2000"` |
| T6d | `w=2001&h=2001` | Both above upper | Root SVG 518×518, no size |
| T6e | `w=99&h=100` | Cross-boundary (both-square) | Root SVG 518×518, no size |
| T6f | `w=200&h=99` | Valid w, h too low (kills height-bound removal) | Root SVG 518×518, no size |
| T6g | `w=99&h=200` | Valid h, w too low (kills width-bound removal) | Root SVG 518×518, no size |
| T6h | `w=200&h=2001` | Valid w, h too high (kills height-bound removal) | Root SVG 518×518, no size |
| T6i | `w=2001&h=200` | Valid h, w too high (kills width-bound removal) | Root SVG 518×518, no size |

### Leading zeros (T7)

| Case | Query | Assertion |
|------|-------|-----------|
| T7 | `w=0100&h=0100` | Root SVG `width="100" height="100"` (accepted, kills `/^[1-9]\d*$/`) |

## Mutant coverage (9 mutants, all killed by committed tests)

Each mutant was independently recreated at the final reviewed head, tests
were run to confirm failure, then the mutant was reverted. No mutant commits
exist.

| # | Mutant | Change | Tests killed |
|---|--------|--------|-------------|
| 1 | Exclusive lower bound | `>=100` → `>100` | T5c, T5d, T6b, T7 |
| 2 | No-leading-zero parser | `/^\d+$/` → `/^[1-9]\d*$/` | T7 |
| 3 | Upper off-by-one | `<=2000` → `<2000` | T5c, T5d, T6c |
| 4 | Permissive parser | Regex guard removed (bare `parseInt`) | T1, T2, T3a, T3b |
| 5 | Width-only `hasCustomSize` | Remove `outputHeight` from guard | T2, T4b, T6f, T6h |
| 6 | Height-only `hasCustomSize` | Remove `outputWidth` from guard | T1, T4a, T6e, T6g, T6i |
| 7 | Square-only | Add `&& outputWidth === outputHeight` | T5b, T5c, T5d |
| 8 | Remove height bounds | Skip height range check | T6f, T6h |
| 9 | Remove width bounds | Skip width range check | T6e, T6g, T6i |

## Gates

### Red gate (`c40e4e5` — six-case matrix on buggy base)
```
CI=true pnpm run test
Test Files  1 failed | 57 passed (58)
Tests       3 failed | 1067 passed | 1 skipped (1071)
```
T1, T2, T3 failed as expected.

### Green gates (all CI=true pnpm run test)
| Commit | Files | Passed | Skipped |
|--------|-------|--------|---------|
| `7920201` (fix) | 58 | 1070 | 1 |
| `ee9dee7` (harden) | 58 | 1077 | 1 |
| `1cb8b19` (refactor) | 58 | 1077 | 1 |
| `ceec071` (non-square/one-invalid) | 58 | 1084 | 1 |
| `00f6f51` (spec correction) | 58 | 1084 | 1 |
| `de4b131` (mutant kill list correction) | 58 | 1084 | 1 |
| (current tip; metadata-only correction) | 58 | 1084 | 1 |

### Typecheck and lint
```
tsc --noEmit      → clean
eslint src        → 0 errors (20 pre-existing warnings)
```

## Final diff

```
WORKHORSE-SPEC.md                 | 225 ++++++++++
src/index.ts                      |   6 +-
test/rasterize-svg-avatar.test.ts | 191 +++++-
3 files changed, 418 insertions(+), 4 deletions(-)
```

Per-file: WORKHORSE-SPEC +225/−0, src/index.ts +4/−2,
test/rasterize-svg-avatar.test.ts +189/−2.

## Exclusions

- `/image` route (W8-ROUTES-002, WEB-1717): untouched, zero diffs.
- `testing-campaign` branch: not copied or cherry-picked.
- No other rasterize behaviour changes.
- No subagents, no `host.sh`, no bare `pnpm run test`.

## Base

`5a5527c7e7ac7c20140bdd81757c5bd075bd389a` (HEAD of main)