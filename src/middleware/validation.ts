import { Context, Next } from 'hono';
import { validateEnsName } from '../utils/ens';

// Validate network parameter
export const validateNetwork = async (c: Context, next: Next) => {
  const network = c.req.param('network');

  if (network && !['mainnet', 'sepolia'].includes(network)) {
    return c.json({
      error: "Invalid network. Must be 'mainnet' or 'sepolia'",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Validate registry type parameter
export const validateRegistryType = async (c: Context, next: Next) => {
  const registryType = c.req.param('registryType');

  if (registryType && !['registry', 'namewrapper'].includes(registryType)) {
    return c.json({
      error: "Invalid registry type. Must be 'registry' or 'namewrapper'",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Validate ENS name parameter
export const validateEnsNameParam = async (c: Context, next: Next) => {
  const name = c.req.param('name');

  if (!name) {
    return c.json({
      error: "Name parameter is required",
      timestamp: new Date().toISOString()
    }, 400);
  }

  if (!validateEnsName(name)) {
    return c.json({
      error: "Invalid ENS name format",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Validate identifier parameter (can be name, tokenId, or hash)
export const validateIdentifier = async (c: Context, next: Next) => {
  const identifier = c.req.param('identifier');

  if (!identifier) {
    return c.json({
      error: "Identifier parameter is required",
      timestamp: new Date().toISOString()
    }, 400);
  }

  // Basic validation - identifier should not be empty
  if (identifier.trim().length === 0) {
    return c.json({
      error: "Identifier cannot be empty",
      timestamp: new Date().toISOString()
    }, 400);
  }

  await next();
};

// Rate limiting placeholder
export const rateLimiter = async (c: Context, next: Next) => {
  // TODO: Implement rate limiting using KV store
  // For now, just pass through
  await next();
};

// Request logging with performance metrics
export const requestLogger = async (c: Context, next: Next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  console.log(`${method} ${path} - ${status} (${duration}ms)`);
};