import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@helix/sdk-web": fileURLToPath(
        new URL("../../packages/sdk-web/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    // Dev: proxy the Helix backend surfaces to the local API server (:3000)
    // so the SPA's relative `/api`, `/oauth`, `/trpc`, … calls reach it.
    proxy: Object.fromEntries(
      [
        "/api",
        "/oauth",
        "/trpc",
        "/mcp",
        "/v1",
        "/healthz",
        "/openapi.json",
        "/openapi.yaml",
        "/asyncapi.json",
        "/metrics",
        "/events",
        "/ws",
        "/sync",
        "/dav",
        "/.well-known",
      ].map((path) => [path, { target: "http://localhost:3000", changeOrigin: true, ws: true }]),
    ),
  },
});
