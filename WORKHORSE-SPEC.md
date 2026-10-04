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

The `imageService.validateOptions()` correctly uses `Number.isInteger`, but:
- For non-square dimensions the rasterize handler does pass `options.size`
  through `validateOptions`, but `parseInt('100a')=100` is a valid integer and
  passes.
- For square custom dimensions the rasterize handler bypasses `options.size`
  entirely and rewrites the SVG width/height attributes directly with the
  attacker-supplied `outputWidth`/`outputHeight`.

## Acceptance contract

The rasterize route supplies a custom size **only** when both `?w=` and `?h=`
are present, each is a pure decimal string (all digits, no sign, no whitespace,
no radix prefix), and each parsed value is within 100–2000 inclusive.
Otherwise — malformed values, missing or incomplete pairs, or out-of-range values —
no custom size is supplied and the defaults (518×518) are used.

Leading-zero decimal spellings (e.g. `w=0100`) are pure decimal strings and are
accepted; `parseInt('0100', 10)` → `100` correctly.

## Proposed fix

Replace the `parseInt`-only parsing with a pure-decimal-integer check on the
query string before conversion. The change in `src/index.ts` ~lines 1094–1095:

```typescript
// Before (buggy):
const outputWidth = c.req.query('w') ? parseInt(c.req.query('w')!, 10) : null;
const outputHeight = c.req.query('h') ? parseInt(c.req.query('h')!, 10) : null;

// After (fixed):
const outputWidth = c.req.query('w') && /^\d+$/.test(c.req.query('w')!) ? parseInt(c.req.query('w')!, 10) : null;
const outputHeight = c.req.query('h') && /^\d+$/.test(c.req.query('h')!) ? parseInt(c.req.query('h')!, 10) : null;
```

The `/^\d+$/` regex rejects non-digit characters (`100a`, `10.5`, `-100`,
`0x64`, ` 200`) and empty strings. Leading zeros (`0100`) are accepted — they
match `\d+` and `parseInt` correctly converts them.

No change to `/image` or any other route. The fix is isolated to the two
query-param parse lines in the rasterize handler.

## TDD matrix

All tests live in `test/rasterize-svg-avatar.test.ts`, in the existing
`describe('/rasterize never hands an SVG avatar to resvg')` block. Each
test asserts against `state.rasterized[0]` (the SVG handed to the mocked
rasterizer) and validates dimension handling. The existing test infrastructure
already mocks the rasterizer, image cache, and metadata service — no new mocks
needed.

### T1 — Malformed width (red → green)
`/mainnet/registry/nick.eth/rasterize?w=100a&h=200`

- **Red:** `parseInt('100a')=100` and `parseInt('200')=200` both pass the
  range guard; `hasCustomSize` is true and the SVG is rewritten to
  `width="100"`. Fixed code treats `w=100a` as null → `hasCustomSize` is false
  → default 518×518.
- **Assert:** `state.rasterized[0]` contains `width="518"` and does **not**
  contain `width="100"`.

### T2 — Malformed height (red → green)
`/mainnet/registry/nick.eth/rasterize?w=200&h=101b`

- **Red:** same class as T1, one dimension is malformed, the other is clean.
  `parseInt('101b')=101` → passes → custom 200×101.
- **Assert:** `state.rasterized[0]` contains `width="518"` (default), not
  `width="200"`.

### T3 — Malformed both (red → green)
`/mainnet/registry/nick.eth/rasterize?w=100a&h=101b`

- **Red:** both parse as 100 and 101 via `parseInt` → custom size applied.
- **Assert:** `state.rasterized[0]` uses default 518×518, contains neither
  `width="100"` nor an attribute reflecting the garbage input.

### T4 — Missing width, clean height (no partial size)
`/mainnet/registry/nick.eth/rasterize?h=200`

- **Green on base (no regression risk):** `hasCustomSize` is already false
  because `outputWidth` is null. The fix must not accidentally accept a
  single-param pair. This test guards against a regression where a future
  change tries to supply a custom size from one param only.
- **Assert:** `state.rasterized[0]` uses default 518×518, never `width="200"`.

### T5 — Clean square custom size (no regression)
`/mainnet/registry/nick.eth/rasterize?w=250&h=250`

- **Green on base, green after fix:** pure decimal, within range → custom
  250×250 applied. Guards against the fix being too restrictive.
- **Assert:** `state.rasterized[0]` matches `/^<svg width="250" height="250"/`.

### T6 — Out-of-range clean value (no regression)
`/mainnet/registry/nick.eth/rasterize?w=99&h=99`

- **Green on base, green after fix:** `hasCustomSize` is already false
  (99 < 100). Guards against the regex fix accidentally widening the range.
- **Assert:** default 518×518.

## Gate

`CI=true pnpm run test` — all existing tests plus the six TDD cases above must
pass after the fix. The change is a pure restriction; no existing test should
rely on malformed query params being accepted.

## Exclusions

- `/image` route (W8-ROUTES-002 / WEB-1717): untouched.
- No copy from `testing-campaign` branch.
- No other rasterize behaviour changes.

## Base

`5a5527c7e7ac7c20140bdd81757c5bd075bd389a` (HEAD of main)