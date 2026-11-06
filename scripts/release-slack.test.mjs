import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const run = (linear, steps = { deploy: { outcome: 'success' }, release: { outcome: 'success' } }) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'release-slack-'));
  try {
    const output = execFileSync(process.execPath, [resolve('scripts/release-slack.mjs'), dir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DRY_RUN: '1',
        TAG: '2026-11-06',
        GITHUB_REPOSITORY: 'ensdomains/metadata-service-v2',
        GITHUB_RUN_ID: '123',
        STEPS: JSON.stringify(steps),
        NEEDS: JSON.stringify({ deploy: { result: 'success' }, linear }),
      },
    });
    return JSON.parse(output.slice(output.indexOf('{')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

for (const [result, outputs, expected] of [
  ['failure', {}, 'Linear sync failed'],
  ['success', { status: 'pending-key' }, 'pipeline access key'],
  ['success', { status: 'success', 'release-url': 'https://linear.app/enslabs/release/example' }, 'https://linear.app/enslabs/release/example'],
]) {
  test(`reports a successful deploy separately from Linear ${result} ${outputs.status ?? ''}`, () => {
    const message = run({ result, outputs });
    assert.match(message.text, /released to prod/);
    assert.match(JSON.stringify(message.blocks), new RegExp(expected));
  });
}

test('deployment failure notifications retain the original failing step', () => {
  const message = run({ result: 'skipped' }, { checks: { outcome: 'failure' }, deploy: { outcome: 'skipped' }, release: { outcome: 'skipped' } });
  assert.match(message.text, /release failed/);
  assert.match(JSON.stringify(message.blocks), /lint, typecheck and test/);
});
