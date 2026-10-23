import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const sharedDir = fileURLToPath(new URL("../../shared", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@shared": sharedDir },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    // The console and the API share one origin: the dev server proxies /api to
    // the API service, so session cookies stay first-party (no CORS at all).
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
    },
    fs: {
      allow: [fileURLToPath(new URL("../..", import.meta.url)), sharedDir],
    },
  },
});
