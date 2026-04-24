#!/usr/bin/env node

// Invalidate caches for ENS names in local dev.
//
// Usage:
//   node scripts/invalidate-cache.mjs                          # flush ALL caches (KV + R2 + CF cache)
//   node scripts/invalidate-cache.mjs nick.eth vitalik.eth     # invalidate specific names via webhook
//   node scripts/invalidate-cache.mjs --port 53518 nick.eth    # custom dev server port

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let port = 8787;
const names = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith('--')) {
    names.push(args[i]);
  }
}

// ── No names → flush everything ──────────────────────────────────────────────

if (names.length === 0) {
  const stateRoot = resolve(import.meta.dirname, '..', '.wrangler', 'state', 'v3');

  if (!existsSync(stateRoot)) {
    console.log('No local wrangler state found — nothing to flush.');
    process.exit(0);
  }

  const targets = [
    { dir: 'kv',    label: 'KV (metadata + SVG caches)' },
    { dir: 'r2',    label: 'R2 (avatars + SVG assets)' },
    { dir: 'cache', label: 'CF Cache API (edge caches)' },
  ];

  console.log('Flushing all local dev caches…\n');

  for (const { dir, label } of targets) {
    const full = resolve(stateRoot, dir);
    if (existsSync(full)) {
      await rm(full, { recursive: true, force: true });
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  – ${label} (not present)`);
    }
  }

  console.log('\nDone. Restart wrangler dev to recreate empty state.');
  process.exit(0);
}

// ── Specific names → webhook invalidation ────────────────────────────────────

const BASE = `http://localhost:${port}`;

async function invalidate(name) {
  const payload = {
    event: 'domain.updated',
    domain: { name },
    timestamp: new Date().toISOString(),
    network: 'mainnet',
  };

  const res = await fetch(`${BASE}/webhook/ensnode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json();

  if (res.ok) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} — ${res.status}: ${body.error || JSON.stringify(body)}`);
  }
  return res.ok;
}

console.log(`Invalidating caches on ${BASE}…\n`);

let allOk = true;
for (const name of names) {
  const ok = await invalidate(name);
  if (!ok) allOk = false;
}

console.log(allOk ? '\nDone.' : '\nCompleted with errors.');
process.exit(allOk ? 0 : 1);
