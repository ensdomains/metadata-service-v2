import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

export interface Env {
  // KV Namespaces
  METADATA_CACHE: KVNamespace;
  SVG_CACHE: KVNamespace;

  // R2 Bucket
  ASSET_BUCKET: R2Bucket;

  // D1 Database
  DB: D1Database;

  // Durable Objects
  REQUEST_DEDUPER: DurableObjectNamespace;

  // Environment Variables
  ENSNODE_GRAPHQL_URL: string;
  MAINNET_RPC_URL: string;
  NAMECHAIN_RPC_URL: string;
  LOG_LEVEL: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use("*", logger());
app.use("*", prettyJSON());

// Health check
app.get("/", (c) => {
  return c.json({
    service: "ENS Metadata V2",
    version: "2.0.0",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// API routes will be added here as we implement them

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// Export Durable Object classes
export { RequestDeduper } from "./durable-objects/request-deduper";

export default app;
