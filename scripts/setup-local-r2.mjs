#!/usr/bin/env node
/**
 * Seed local R2 preview bucket with required assets (fonts).
 * Runs before `pnpm dev` via the `setup:local` script.
 */
import { execSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BUCKET = 'ens-metadata-assets-preview';

// 1. Upload rasterize-wasm fonts (brotli-compressed)
const rasterizeFontsDir = resolve('node_modules/rasterize-wasm/fonts');
if (existsSync(rasterizeFontsDir)) {
  const brFiles = readdirSync(rasterizeFontsDir).filter(f => f.endsWith('.br'));
  for (const file of brFiles) {
    execSync(
      `pnx wrangler r2 object put ${BUCKET}/fonts/${file} --file="${resolve(rasterizeFontsDir, file)}" --local`,
      { stdio: 'pipe' }
    );
  }
  console.log(`[setup-local-r2] ${brFiles.length} rasterize fonts uploaded`);
}

// 2. Upload Satoshi-Bold.ttf from adaptive-layout-composer / canvas-cf
const satoshiPaths = [
  resolve('node_modules/adaptive-layout-composer/assets/Satoshi-Bold.ttf'),
  resolve('../canvas-cf/assets/Satoshi-Bold.ttf'),
  resolve('../../canvas-cf/assets/Satoshi-Bold.ttf'),
];
const satoshiPath = satoshiPaths.find(p => existsSync(p));
if (satoshiPath) {
  execSync(
    `pnx wrangler r2 object put ${BUCKET}/fonts/Satoshi-Bold.ttf --file="${satoshiPath}" --local`,
    { stdio: 'pipe' }
  );
  console.log(`[setup-local-r2] Satoshi-Bold.ttf uploaded`);
} else {
  console.warn(`[setup-local-r2] Satoshi-Bold.ttf not found — image generation will fail`);
}

console.log('[setup-local-r2] done');
