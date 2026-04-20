#!/usr/bin/env node
/**
 * Upload rasterize-wasm font assets to R2 bucket.
 * Usage: node scripts/upload-fonts-to-r2.mjs [--remote] [--env production]
 *
 * Uploads all .ttf.br and .json.br files from rasterize-wasm/fonts/ to
 * the ASSET_BUCKET R2 bucket under the "fonts/" prefix.
 *
 * By default uploads to local R2 (wrangler dev). Pass --remote for production.
 */
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const fontsDir = resolve('node_modules/rasterize-wasm/fonts');
const files = readdirSync(fontsDir).filter(f => f.endsWith('.br'));
const remoteFlag = process.argv.includes('--remote') ? '--remote' : '';
const envFlag = process.argv.includes('--env')
  ? `--env ${process.argv[process.argv.indexOf('--env') + 1]}`
  : '';

console.log(`Uploading ${files.length} font assets to R2 (ASSET_BUCKET) ${remoteFlag || '(local)'}...\n`);

for (const file of files) {
  const localPath = resolve(fontsDir, file);
  const r2Key = `fonts/${file}`;
  console.log(`  ${file} -> ${r2Key}`);
  execSync(
    `npx wrangler r2 object put ens-metadata-assets/${r2Key} --file="${localPath}" ${remoteFlag} ${envFlag}`.trim(),
    { stdio: 'inherit' }
  );
}

console.log(`\nDone. ${files.length} files uploaded.`);
