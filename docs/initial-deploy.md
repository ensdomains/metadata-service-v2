---
title: "Metadata service v2: initial deploy"
status: draft
description: "One-time setup of the metadata-service-v2 Worker on Cloudflare for stage and prod: secrets, the EU D1 database, first deploy, migrations, and the R2 fonts that /image and /rasterize need."
type: reference
tags:
  - metadata
  - cloudflare
  - wrangler
  - deploy
source:
  - "metadata-service-v2: wrangler.toml, package.json, scripts/upload-fonts-to-r2.mjs, .github/workflows/release.yml"
snapshot: 2026-10-14
owner: web team
---

# Initial deploy

One-time setup of a new Worker on Cloudflare. The commands below set up
**stage** (`ens-metadata-stage`); for **prod** (`ens-metadata`), use the
command in the comment next to each one. After this, Workers Builds deploys
stage and `release.yml` deploys prod.

Log in first with `wrangler login`, or set `CLOUDFLARE_API_TOKEN` to that
Worker's token.

## 1. Create secrets

```bash
wrangler secret put MAINNET_RPC_URL --env stage   # prod: --env=""
wrangler secret put SEPOLIA_RPC_URL --env stage
wrangler secret put WEBHOOK_SECRET --env stage
```

The first secret asks to create the Worker, since it does not exist yet.
Answer yes:

```
✔ There doesn't seem to be a Worker called "ens-metadata". Do you want to create a new Worker with that name and add secrets to it? … yes
```

(For stage the name is `ens-metadata-stage`.)

Stage only: Previews have their own secret store, so set the same three with
`wrangler preview base-config secret put <NAME> --env stage`.

## 2. Create the database

```bash
wrangler d1 create ens-metadata-stage-db --jurisdiction eu   # prod: ens-metadata-db
```

Create it by hand: a D1 binding cannot set a jurisdiction, so a database
created by the deploy would not be in the EU.

## 3. Deploy the app

```bash
pnpm deploy:stage   # prod: pnpm run deploy
```

The first deploy creates the KV namespaces and the EU R2 bucket
(`ens-metadata-stage-asset-bucket`).

## 4. Migrate the database

```bash
pnpm db:migrate:remote:stage   # prod: pnpm db:migrate:remote
```

## 5. Upload fonts

```bash
node scripts/upload-fonts-to-r2.mjs --remote --env stage   # prod: drop --env stage
```

## 6. Upload the Satoshi Bold font

```bash
wrangler r2 object put ens-metadata-stage-asset-bucket/fonts/Satoshi-Bold.ttf \
  --file=/path/to/Satoshi-Bold.ttf --remote --jurisdiction eu --env stage
# prod: ens-metadata-asset-bucket/... and --env=""
```

The font is not in npm; take it from a `canvas-cf` checkout (`assets/`).
Without the fonts from steps 5 and 6, `/image` and `/rasterize` return 500.
