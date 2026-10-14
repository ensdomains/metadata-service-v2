#!/usr/bin/env node
/**
 * Upload rasterize-wasm font assets to R2 bucket.
 * Usage: node scripts/upload-fonts-to-r2.mjs [--remote] [--env stage] [--bucket <name>]
 *
 * Uploads all .ttf.br and .json.br files from rasterize-wasm/fonts/ to
 * the ASSET_BUCKET R2 bucket under the "fonts/" prefix.
 *
 * By default uploads to local R2 (wrangler dev). Pass --remote for the
 * deployed bucket: prod's without --env, stage's with --env stage. The
 * jurisdiction comes from that environment's ASSET_BUCKET binding in
 * wrangler.toml, and so does the bucket name when the binding sets one.
 * Without one, the bucket was auto-provisioned on deploy and wrangler named it
 * `<worker name>-asset-bucket` (e.g. ens-metadata-stage-asset-bucket);
 * pass --bucket if a different name was chosen at the deploy prompt.
 */
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { unstable_readConfig } from 'wrangler';

const fontsDir = resolve('node_modules/rasterize-wasm/fonts');
const files = readdirSync(fontsDir).filter(f => f.endsWith('.br'));
const remoteFlag = process.argv.includes('--remote') ? '--remote' : '';
const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : '';
const envFlag = `--env="${env}"`;
const bucketArg = process.argv.includes('--bucket') ? process.argv[process.argv.indexOf('--bucket') + 1] : '';

const config = unstable_readConfig({ config: resolve('wrangler.toml'), env }, { hideWarnings: true });
const bucket = config.r2_buckets.find(b => b.binding === 'ASSET_BUCKET');
if (!bucket) throw new Error(`No ASSET_BUCKET binding in wrangler.toml for env "${env || 'prod'}"`);
// Wrangler's name for a bucket it auto-provisions for this binding.
const autoProvisionedName = `${config.name}-${bucket.binding.toLowerCase().replaceAll('_', '-')}`;
// Locally, match scripts/setup-local-r2.mjs, which seeds the preview bucket.
const bucketName = bucketArg
  || (remoteFlag ? bucket.bucket_name : bucket.preview_bucket_name ?? bucket.bucket_name)
  || autoProvisionedName;
// A bucket in a jurisdiction is only reachable with that jurisdiction.
const jurisdictionFlag = remoteFlag && bucket.jurisdiction ? `--jurisdiction ${bucket.jurisdiction}` : '';

console.log(`Uploading ${files.length} font assets to R2 bucket ${bucketName} (ASSET_BUCKET) ${remoteFlag || '(local)'}...\n`);

for (const file of files) {
  const localPath = resolve(fontsDir, file);
  const r2Key = `fonts/${file}`;
  console.log(`  ${file} -> ${r2Key}`);
  execSync(
    `pnx wrangler r2 object put ${bucketName}/${r2Key} --file="${localPath}" ${remoteFlag} ${jurisdictionFlag} ${envFlag}`.trim(),
    { stdio: 'inherit' }
  );
}

console.log(`\nDone. ${files.length} files uploaded.`);
