# ENS Metadata Service V2

Next-generation ENS metadata service built on Cloudflare Workers for ENS v1 and v2 on Ethereum (mainnet + sepolia testnet).

## Features

- **ENS v1 & v2 Support**: Native v2 names and legacy v1 names on Ethereum
- **High Performance**: Cloudflare Workers edge computing with global distribution
- **Smart Caching**: KV-based caching with migration-aware TTL strategies
- **Fallback Resilience**: Direct chain queries when ensnode is unavailable
- **SVG Generation**: Canvas-free image generation for better performance

## Architecture

- **Runtime**: Cloudflare Workers + Hono
- **Storage**: KV (cache), D1 (analytics), R2 (assets)
- **Data Sources**: ensnode indexer (primary), viem clients (fallback)
- **Networks**: Ethereum mainnet + Sepolia testnet

## Development

```bash
# Install dependencies
yarn install

# Start development server
yarn dev

# Run tests
yarn test

# Type checking
yarn typecheck

# Linting
yarn lint
```

## Deployment

```bash
# Deploy to Cloudflare Workers
yarn deploy
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

**Required:**
- `ENSNODE_GRAPHQL_URL`: ensnode GraphQL endpoint
- `MAINNET_RPC_URL`: Primary Ethereum mainnet RPC endpoint
- `SEPOLIA_RPC_URL`: Primary Sepolia testnet RPC endpoint
- `LOG_LEVEL`: Logging level (debug, info, warn, error)

**Optional Fallback RPCs:**
- `MAINNET_FALLBACK_RPC_1`, `MAINNET_FALLBACK_RPC_2`, `MAINNET_FALLBACK_RPC_3`: Ethereum mainnet fallback endpoints
- `SEPOLIA_FALLBACK_RPC_1`, `SEPOLIA_FALLBACK_RPC_2`: Sepolia testnet fallback endpoints

If no fallback RPCs are provided, the service will use default public RPC endpoints.

## API Endpoints

- `/{network}/{registryType}/{identifier}` - Get NFT metadata (`registryType` = `registry` | `namewrapper`, or a v1 contract address; `identifier` = ENS name, or a v1 token id)
- `/{network}/{registryType}/{identifier}/image` - NFT card image (SVG)
- `/{network}/{registryType}/{identifier}/rasterize` - NFT card image rasterized to PNG
- `/{network}/avatar/{name}` - Avatar image bytes (the `avatar` text record)
- `/{network}/avatar/{name}/meta` - Avatar record metadata (NFT `host_meta`, `is_owner`, `image_url`, …); v1 parity
- `/{network}/header/{name}` - Header/banner image bytes (the `header` text record)
- `/migration-status/{name}` - Check migration status
- `/registry-hierarchy/{name}` - Get registry hierarchy
- `/batch-metadata` - Batch metadata requests
- `/health` - Service health check
