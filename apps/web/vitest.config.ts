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
    // The large editor suites use React's process-global act queue. Running
    // those files concurrently lets one timed-out render poison unrelated
    // suites, so keep file execution deterministic.
    fileParallelism: false,
    setupFiles: ["./src/test/setup.ts"],
    // Editor integration tests perform full document and presentation renders.
    // Shared GitHub runners can exceed Vitest's 5-second default even when the
    // same render completes quickly on a developer workstation.
    testTimeout: 30_000,
  },
});
