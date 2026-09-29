import { describe, it, expect, vi } from 'vitest';
import { captureConsole, driveRoutesWithFailingUpstreams, MKEY, SKEY } from './log-redaction-e2e.shared';

vi.mock('../src/services/rasterize', () => ({
  RasterizeService: class {
    async rasterize() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  },
}));

// Regression (WEB-1554): the Worker itself must install the redaction. If
// installConsoleRedaction() is removed from src/index, this test fails.
const calls = captureConsole();

describe('end-to-end: every route with every upstream failing', () => {
  it('never lets an RPC key reach a console sink', async () => {
    const dump = await driveRoutesWithFailingUpstreams(calls);
    expect(dump).not.toContain(MKEY);
    expect(dump).not.toContain(SKEY);
    expect(dump).toContain('[redacted]');
  }, 180_000);
});
