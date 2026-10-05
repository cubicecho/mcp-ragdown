import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // LanceDB and the hash embedder are fast, but a sync touches the disk several times.
    testTimeout: 20_000,
  },
});
