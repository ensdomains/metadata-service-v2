# ENS Metadata Service V2

[![CI](https://github.com/mdtanrikulu/metadata-service-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/mdtanrikulu/metadata-service-v2/actions/workflows/ci.yml)

Next-generation ENS metadata service built on Cloudflare Workers for ENS v1 and v2 on Ethereum (mainnet + sepolia testnet).

## Features

- **ENS v1 & v2 Support**: Native v2 names and legacy v1 names on Ethereum
- **High Performance**: Cloudflare Workers edge computing with global distribution
- **Smart Caching**: Edge + KV + R2 caching; the KV and R2 tiers use migration-aware, stale-while-revalidate TTLs, while the per-colo edge tier is a flat 300s cap
- **Fallback Resilience**: For name lookups, direct chain queries when the indexers are unavailable *or* simply don't know the name, then a stale D1 row as a last resort (the `contract/tokenId` reverse lookup is indexer-only)
- **SVG Generation**: Canvas-free SVG card generation, with in-Worker PNG rasterization via resvg/HarfBuzz WASM

## Architecture

- **Runtime**: Cloudflare Workers + Hono
- **Storage**: KV (metadata + SVG cache), R2 (fonts, L2 SVG cache, cached avatars), D1 (migration statuses + last-resort data tier), plus the per-colo Cloudflare edge cache (capped at 300s because the webhook cannot purge it globally)
- **Data Sources** (tiered, per network):
  - mainnet: ENSNode subgraph (v1 queries) → on-chain via viem → stale D1
  - sepolia: zigens ENS v2 indexer (primary) → ENSNode sepolia subgraph (v1 secondary) → on-chain via viem (live v2 registry discovery through the UniversalResolver proxy) → stale D1
  - The chain tier runs both when an indexer is down (upstream error) and when it has no record of the name (clean miss). A circuit breaker guards the **primary indexer tier only** (mainnet: the ENSNode subgraph; sepolia: zigens) — only an upstream error trips it (a miss never does), it stays open for 60s per isolate, and the sepolia secondary v1 subgraph and the on-chain tier have no breaker.
- **Networks**: Ethereum mainnet (ENS v1; v2 contracts are placeholders until v2 deploys there) + Sepolia testnet (ENS v1 + v2)

## Development

```bash
# Install dependencies
pnpm install

# Start development server (also seeds the local R2 bucket with fonts and
# applies pending D1 migrations first — the `predev` step)
yarn dev

# Apply D1 migrations manually
pnpm db:migrate:local
pnpm db:migrate:remote

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Linting
pnpm lint
```

`predev` uploads the rasterize font pack from `node_modules/rasterize-wasm/fonts/` and looks
for `Satoshi-Bold.ttf` in `node_modules/adaptive-layout-composer/assets/`, `../canvas-cf/assets/`
or `../../canvas-cf/assets/` (relative to the repo root). The published `adaptive-layout-composer`
package ships no `assets/` directory, so in practice the font comes from a `canvas-cf` checkout
next to this repo. If it is not found `predev` only warns, and the `/image` and `/rasterize`
endpoints return `500` locally until `fonts/Satoshi-Bold.ttf` exists in the local R2 bucket.

## Deployment

```bash
# Set production secrets (once)
wrangler secret put MAINNET_RPC_URL
wrangler secret put SEPOLIA_RPC_URL
wrangler secret put WEBHOOK_SECRET

# Upload font assets to the production R2 bucket (once). Without them /image and
# /rasterize return 500 on every cache miss and the Worker logs
# "Font not found in R2: fonts/<file>".
node scripts/upload-fonts-to-r2.mjs --remote   # rasterize font pack + twemoji → fonts/*.br
wrangler r2 object put ens-metadata-assets/fonts/Satoshi-Bold.ttf --file=/path/to/Satoshi-Bold.ttf --remote

# Apply D1 migrations to the remote database (once per new migration)
pnpm db:migrate:remote

# Deploy to Cloudflare Workers
pnpm run deploy
```

Non-secret production vars (indexer URLs, fallback RPCs, `LOG_LEVEL`,
`MAX_AVATAR_BYTES`) live in `wrangler.toml` under `[vars]`.

## Environment Variables

For local development, put secrets in `.dev.vars` (wrangler's local secrets file, gitignored).
Wrangler only falls back to a `.env` file (copy `.env.example`) when no `.dev.vars` exists —
once `.dev.vars` is present, `.env` is ignored. `wrangler.toml` `[vars]` are loaded in both
cases, but any key that also appears in `.dev.vars` or `.env` overrides the `[vars]` value, so
keep only secrets and deliberate local overrides in those files.

**Required** (not validated at startup: a missing RPC URL silently falls back to viem's built-in
public RPC for that chain, and a missing indexer URL makes every indexer query fail and drop to
the on-chain tier):
- `MAINNET_RPC_URL`: Primary Ethereum mainnet RPC endpoint (production: `wrangler secret put`)
- `SEPOLIA_RPC_URL`: Primary Sepolia testnet RPC endpoint (production: `wrangler secret put`)
- `ENSNODE_MAINNET_URL`: ENSNode subgraph endpoint for mainnet (v1 queries)
- `ENSNODE_SEPOLIA_V2_URL`: zigens ENS v2 indexer endpoint for sepolia (primary)

**Optional:**
- `ENSNODE_SEPOLIA_V1_URL`: ENSNode sepolia subgraph (v1 secondary indexer for v1-only names)
- `MAINNET_FALLBACK_RPC_1..3`: fallback RPC endpoints (if none is set, mainnet uses built-in public RPCs; setting any one replaces that built-in list entirely)
- `SEPOLIA_FALLBACK_RPC_1..2`: fallback RPC endpoints — sepolia has **no** built-in defaults, so without these every sepolia on-chain read depends on the single `SEPOLIA_RPC_URL`
- `MAX_AVATAR_BYTES`: cap on fetched avatar size in bytes (default 25 MB)
- `MAX_BATCH_NAMES`: max names per `POST /batch-metadata` request (default 25)
- `RATE_LIMIT_DISABLED`: set to `true` to disable the per-IP rate limiter (local dev). Limits are per IP per 60s window: 120 default, 60 for `/image` and `/webhook`, 30 for `/rasterize`, 20 for `/batch-metadata`; `/` and `/health` are exempt
- `LOG_LEVEL`: declared in the Worker env and set in `wrangler.toml`, but not currently read by the code

**Webhook (`POST /webhook`):**
- `WEBHOOK_SECRET`: hex-encoded HMAC key for webhook signatures — **required in production; the webhook rejects all requests without it** (production: `wrangler secret put`)
- `WEBHOOK_TOLERANCE_SECS`: replay window for webhook timestamps, in seconds (default 120)
- `WEBHOOK_ALLOW_UNAUTHENTICATED`: local dev only — accept webhooks without a secret

## API Endpoints

`{network}` is `mainnet` or `sepolia`.

- `GET /` - Service info (`service`, `version`, `status`, `timestamp`)
- `GET /{network}/{registryType}/{identifier}` - NFT metadata. `registryType` = `registry` | `namewrapper`, or a registrar contract address (the v1 BaseRegistrar, the v1 NameWrapper, or the v2 ETHRegistry where v2 is deployed; any other address is a `404`). `identifier` = ENS name, or that contract's token id (decimal or `0x` hex). The `contract/tokenId` → name step queries the indexers only
- `GET /{network}/{registryType}/{identifier}/image` - NFT card image (SVG). Optional `?w=&h=` (both required, 100–2000 px) and `?status=` (`unmigrated` | `migrated` | `native`; overrides the rendered status — badge, colours and cache TTL — but never the existence check)
- `GET /{network}/{registryType}/{identifier}/rasterize` - NFT card image rasterized to PNG. Same query params; `?w=`/`?h=` are ignored unless both are within 100–2000
- `GET /{network}/avatar/{name}` - Avatar image bytes (the `avatar` text record)
- `GET /{network}/avatar/{name}/meta` - Avatar record metadata (NFT `host_meta`, `is_owner`, `image_url`, …); v1 parity
- `GET /{network}/header/{name}` - Header/banner image bytes (the `header` text record)
- `GET /migration-status/{name}?network=` - Check migration status (network from the query param, default `mainnet`)
- `GET /registry-hierarchy/{name}?network=` - Get registry hierarchy (network from the query param, default `mainnet`). This route never answers `404` or `503`: when no indexer, chain or D1 source can resolve the name it returns a `200` placeholder hierarchy with zero-address owners (cached briefly)
- `POST /batch-metadata` - Batch metadata. JSON body `{ names: string[] (1–25 by default, `MAX_BATCH_NAMES`), network?: "mainnet" | "sepolia" (default `mainnet`), registryType?: "registry" | "namewrapper" (default `registry`) }`; names that differ only in case are resolved once; returns `{ results, total, successful, failed }`
- `POST /webhook` - Indexer webhook (HMAC-authenticated): purges the KV and R2 caches for the name on both networks (edge entries for its `/image` and `/rasterize` URLs are evicted on the receiving colo only; everything else at the edge expires within 300s), records the name's migration status in D1 and re-warms the default card image (see `docs/webhook.md`)
- `GET /health` - Service health check

Error responses: `400` bad input, `404` unknown name, `410` expired name, `429` rate limited, `503` when the name cannot be resolved because an indexer or RPC tier was unreachable, and `504` after the 30s request timeout. On the metadata, image, rasterize and migration-status routes an outage is never reported as a `404`; the avatar, header and avatar-meta routes answer `404` whenever the record cannot be resolved, outage included.
