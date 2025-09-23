# ENS Metadata Service V2

Next-generation ENS metadata service built on Cloudflare Workers with L1/L2 support.

## Features

- **Multi-chain Support**: Native L2 names, ejected L1 names, and legacy v1 names
- **High Performance**: Cloudflare Workers edge computing with global distribution
- **Smart Caching**: KV-based caching with migration-aware TTL strategies
- **Fallback Resilience**: Direct chain queries when ensnode is unavailable
- **SVG Generation**: Canvas-free image generation for better performance

## Architecture

- **Runtime**: Cloudflare Workers + Hono
- **Storage**: KV (cache), D1 (analytics), R2 (assets)
- **Data Sources**: ensnode indexer (primary), viem clients (fallback)
- **Chains**: Ethereum L1 + Namechain L2

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
- `MAINNET_RPC_URL`: Primary Ethereum L1 RPC endpoint
- `NAMECHAIN_RPC_URL`: Primary Namechain L2 RPC endpoint
- `LOG_LEVEL`: Logging level (debug, info, warn, error)

**Optional Fallback RPCs:**
- `MAINNET_FALLBACK_RPC_1`, `MAINNET_FALLBACK_RPC_2`, `MAINNET_FALLBACK_RPC_3`: Ethereum L1 fallback endpoints
- `NAMECHAIN_FALLBACK_RPC_1`, `NAMECHAIN_FALLBACK_RPC_2`: Namechain L2 fallback endpoints

If no fallback RPCs are provided, the service will use default public RPC endpoints.

## API Endpoints

- `/{network}/{registryType}/{identifier}` - Get metadata
- `/migration-status/{name}` - Check migration status
- `/registry-hierarchy/{name}` - Get registry hierarchy
- `/batch-metadata` - Batch metadata requests