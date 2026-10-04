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
this ticket (W8-ROUTES-002).

The `imageService.validateOptions()` correctly uses `Number.isInteger`, but:
- For non-square dimensions the rasterize handler does pass `options.size`
  through `validateOptions`, but `parseInt('100a')=100` is a valid integer and
  passes.
- For square custom dimensions the rasterize handler bypasses `options.size`
  entirely and rewrites the SVG width/height attributes directly with the
  attacker-supplied `outputWidth`/`outputHeight`.

## Proposed fix

Replace the `parseInt`-only parsing with a pure-decimal-integer check on the
query string before conversion. The simplest correct change in
`src/index.ts` ~lines 1094–1095:

```typescript
// Before (buggy):
const outputWidth = c.req.query('w') ? parseInt(c.req.query('w')!, 10) : null;
const outputHeight = c.req.query('h') ? parseInt(c.req.query('h')!, 10) : null;

// After (fixed):
const outputWidth = c.req.query('w') && /^\d+$/.test(c.req.query('w')!) ? parseInt(c.req.query('w')!, 10) : null;
const outputHeight = c.req.query('h') && /^\d+$/.test(c.req.query('h')!) ? parseInt(c.req.query('h')!, 10) : null;
```

This rejects any query value that contains non-digit characters (e.g. `100a`,
`10.5`, `-100`, `0x64`), causing the handler to fall through to default
dimensions. The `/^\d+$/` test also naturally rejects empty strings (already
handled by the ternary guard), whitespace, and leading zeros — all of which
`parseInt` would quietly convert.

No change to `/image` or any other route. The fix is isolated to the two
query-param parse lines in the rasterize handler.

## Test plan

1. **Regression test (red):** Add a test in `test/rasterize-svg-avatar.test.ts`
   that calls `/mainnet/registry/nick.eth/rasterize?w=100a&h=101` (or similar
   malformed params) and asserts that the rasterized SVG uses the default
   518×518 dimensions, not the attacker-selected 100×101. This test must fail
   on the base commit (red).

2. **Apply fix:** The two-line change above.

3. **Regression test (green):** The same test now passes.

4. **Gate:** `CI=true pnpm run test` — all existing tests must continue to pass
   (the change is a pure restriction; no existing test should rely on malformed
   query params being accepted).

## Exclusions

- `/image` route (W8-ROUTES-002): untouched.
- No copy from `testing-campaign` branch.
- No other rasterize behaviour changes.

## Base

`5a5527c7e7ac7c20140bdd81757c5bd075bd389a` (HEAD of main)