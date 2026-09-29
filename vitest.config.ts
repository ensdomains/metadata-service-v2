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
      // The rasterizer's .wasm imports (src/services/rasterize.ts), which wrangler
      // bundles as compiled modules and Node cannot import. Only these: another
      // .wasm consumer must not silently get the stub in its tests.
      {
        find: /^(rasterize-wasm\/wasm\/resvg|harfbuzzjs\/hb|harfbuzzjs\/trampolines\/trampoline-[a-z]+|tiny-brotli-dec-wasm\/build\/tiny-brotli-dec-wasm)\.wasm$/,
        replacement: path.resolve(__dirname, "./test/mocks/wasm-stub.ts"),
      },
    ],
  },
});
