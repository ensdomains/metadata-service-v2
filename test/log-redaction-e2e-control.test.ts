import { describe, it, expect, vi } from 'vitest';
import { captureConsole, driveRoutesWithFailingUpstreams, MKEY, SKEY } from './log-redaction-e2e.shared';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

// Control for log-redaction-e2e.test.ts: the same run with the wrapper
// suppressed (marker preset) leaks both keys, so that test is not vacuous.
(console as unknown as Record<symbol, boolean>)[Symbol.for('ens-metadata.console-redaction')] = true;
const calls = captureConsole();

describe('end-to-end control: without the console wrapper', () => {
  it('the same routes write both RPC keys to the console', async () => {
    const dump = await driveRoutesWithFailingUpstreams(calls);
    expect(dump).toContain(MKEY);
    expect(dump).toContain(SKEY);
  }, 180_000);
});
