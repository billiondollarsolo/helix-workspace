import { helixVitestConfig } from "../../packages/config/vitest/index.ts";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  helixVitestConfig,
  defineConfig({
    test: {
      coverage: { thresholds: { functions: 74 } },
      setupFiles: ["./src/test-support/live-database.setup.ts"],
    },
  }),
);
