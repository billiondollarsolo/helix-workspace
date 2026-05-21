import { defineConfig } from "vitest/config";

export const helixVitestConfig = defineConfig({
  test: {
    coverage: {
      reporter: ["text", "lcov"],
    },
    environment: "node",
    globals: true,
  },
});
