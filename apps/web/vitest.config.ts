import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@helix/sdk-types": fileURLToPath(
        new URL("../../packages/sdk-types/src/index.ts", import.meta.url),
      ),
      "@helix/sdk-web": fileURLToPath(
        new URL("../../packages/sdk-web/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    setupFiles: ["./src/test/setup.ts"],
  },
});
