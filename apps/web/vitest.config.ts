import { fileURLToPath, URL } from "node:url";
import { helixVitestConfig } from "@helix/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  helixVitestConfig,
  defineConfig({
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
      coverage: { thresholds: { statements: 73, branches: 67, functions: 68, lines: 74 } },
      // React suites use a process-global act queue. Running
      // those files concurrently lets one timed-out render poison unrelated
      // suites, so keep file execution deterministic.
      fileParallelism: false,
      setupFiles: ["./src/test/setup.ts"],
      // Shared runners need time for complete application renders.
      testTimeout: 30_000,
    },
  }),
);
