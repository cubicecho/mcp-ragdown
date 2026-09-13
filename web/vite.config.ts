import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // `src/http.ts` serves this folder; see `WEB_DIR` there.
    outDir: "dist",
    // One page for a local tool: splitting would add requests, not save any.
    chunkSizeWarningLimit: 1000,
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // In dev vite serves the app and `ragdown serve` runs on :3000, so the API is forwarded and
    // the client uses the same relative URLs it does in production, where one server does both.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
