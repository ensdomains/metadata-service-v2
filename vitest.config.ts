import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["refproject/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      // Measure the Worker source only, not scripts/ or demo/.
      include: ["src/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
