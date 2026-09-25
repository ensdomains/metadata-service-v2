import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["refproject/**", "node_modules/**", ".yarn/**"],
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // wrangler bundles .wasm imports as compiled modules; Node cannot import them.
      { find: /^.*\.wasm$/, replacement: path.resolve(__dirname, "./test/mocks/wasm-stub.ts") },
    ],
  },
});
