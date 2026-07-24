# ENS Metadata Service V2

[![CI](https://github.com/mdtanrikulu/metadata-service-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/mdtanrikulu/metadata-service-v2/actions/workflows/ci.yml)

Next-generation ENS metadata service built on Cloudflare Workers for ENS v1 and v2 on Ethereum (mainnet + sepolia testnet).

## Features

- **ENS v1 & v2 Support**: Native v2 names and legacy v1 names on Ethereum
- **High Performance**: Cloudflare Workers edge computing with global distribution
- **Smart Caching**: KV-based caching with migration-aware TTL strategies
- **Fallback Resilience**: Direct chain queries when ensnode is unavailable
- **SVG Generation**: Canvas-free image generation for better performance

## Architecture

- **Runtime**: Cloudflare Workers + Hono
- **Storage**: KV (metadata/SVG cache), D1 (migration statuses + last-resort data tier), R2 (assets)
- **Data Sources** (tiered, per network, with circuit breaker):
  - mainnet: ENSNode subgraph (v1 queries) → on-chain via viem → stale D1
  - sepolia: zigens ENS v2 indexer (primary) → ENSNode sepolia subgraph (v1 secondary) → on-chain via viem (live v2 registry discovery through the UniversalResolver proxy) → stale D1
- **Networks**: Ethereum mainnet (ENS v1; v2 contracts are placeholders until v2 deploys there) + Sepolia testnet (ENS v1 + v2)

## Development

```bash
# Install dependencies
yarn install

# Start development server (also sets up local R2 and applies pending D1
# migrations first — the `predev` step)
yarn dev

# Apply D1 migrations manually
yarn db:migrate:local
yarn db:migrate:remote

# Run tests
yarn test

# Type checking
yarn typecheck

# Linting
yarn lint
```

## Deployment

```bash
# Set production secrets (once)
wrangler secret put MAINNET_RPC_URL
wrangler secret put SEPOLIA_RPC_URL
wrangler secret put WEBHOOK_SECRET

# Apply D1 migrations to the remote database (once per new migration)
yarn db:migrate:remote

# Deploy to Cloudflare Workers
yarn deploy
```

Non-secret production vars (indexer URLs, fallback RPCs, `LOG_LEVEL`,
`MAX_AVATAR_BYTES`) live in `wrangler.toml` under `[vars]`.

## Environment Variables

For local development, copy `.env.example` to `.env` and configure:

**Required:**
- `MAINNET_RPC_URL`: Primary Ethereum mainnet RPC endpoint (production: `wrangler secret put`)
- `SEPOLIA_RPC_URL`: Primary Sepolia testnet RPC endpoint (production: `wrangler secret put`)
- `ENSNODE_MAINNET_URL`: ENSNode subgraph endpoint for mainnet (v1 queries)
- `ENSNODE_SEPOLIA_V2_URL`: zigens ENS v2 indexer endpoint for sepolia (primary)
- `LOG_LEVEL`: Logging level (debug, info, warn, error)

**Optional:**
- `ENSNODE_SEPOLIA_V1_URL`: ENSNode sepolia subgraph (v1 secondary indexer for v1-only names)
- `MAINNET_FALLBACK_RPC_1..3`, `SEPOLIA_FALLBACK_RPC_1..2`: fallback RPC endpoints (mainnet falls back to default public RPCs if unset)
- `MAX_AVATAR_BYTES`: cap on fetched avatar size in bytes (default 25 MB)
- `RATE_LIMIT_DISABLED`: set to `true` to disable the per-IP rate limiter (local dev)

**Webhook (`POST /webhook`):**
- `WEBHOOK_SECRET`: hex-encoded HMAC key for webhook signatures — **required in production; the webhook rejects all requests without it** (production: `wrangler secret put`)
- `WEBHOOK_TOLERANCE_SECS`: replay window for webhook timestamps (default 300)
- `WEBHOOK_ALLOW_UNAUTHENTICATED`: local dev only — accept webhooks without a secret

## API Endpoints

- `/{network}/{registryType}/{identifier}` - Get NFT metadata (`registryType` = `registry` | `namewrapper`, or a v1 contract address; `identifier` = ENS name, or a v1 token id)
- `/{network}/{registryType}/{identifier}/image` - NFT card image (SVG)
- `/{network}/{registryType}/{identifier}/rasterize` - NFT card image rasterized to PNG
- `/{network}/avatar/{name}` - Avatar image bytes (the `avatar` text record)
- `/{network}/avatar/{name}/meta` - Avatar record metadata (NFT `host_meta`, `is_owner`, `image_url`, …); v1 parity
- `/{network}/header/{name}` - Header/banner image bytes (the `header` text record)
- `/migration-status/{name}` - Check migration status
- `/registry-hierarchy/{name}` - Get registry hierarchy
- `POST /batch-metadata` - Batch metadata requests (max 100 names)
- `POST /webhook` - Indexer webhook for cache invalidation + migration-status updates (HMAC-authenticated)
- `/health` - Service health check
