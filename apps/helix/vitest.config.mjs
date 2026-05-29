import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@helix/sdk": fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url)),
      "@helix/sdk-types": fileURLToPath(
        new URL("../../packages/sdk-types/src/index.ts", import.meta.url),
      ),
    },
  },
});
