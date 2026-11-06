import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPreviousRelease } from './previous-release.mjs';

test('failed tags are included in the next successful production release range', () => {
  assert.equal(getPreviousRelease({ tag: '2026-11-06.3', tags: ['2026-11-06', '2026-11-06.2'], releasedTags: ['2026-11-06'] }), '2026-11-06');
});
test('sorts same-day counters numerically and excludes the current tag on retry', () => {
  assert.equal(getPreviousRelease({ tag: '2026-11-06.11', tags: ['2026-11-06.2', 'v1', '2026-11-06.11', '2026-11-06.10'], releasedTags: ['2026-11-06.2', '2026-11-06.10', '2026-11-06.11'] }), '2026-11-06.10');
});
test('first deployment has no successful baseline', () => {
  assert.equal(getPreviousRelease({ tag: '2026-11-06', tags: ['2026-11-05'], releasedTags: [] }), undefined);
});
