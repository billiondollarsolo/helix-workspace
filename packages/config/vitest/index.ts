import { defineConfig } from "vitest/config";

export const helixVitestConfig = defineConfig({
  test: {
    coverage: {
      reporter: ["text", "lcov", "json-summary"],
      reportOnFailure: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test-support/**",
        "src/test/**",
        "src/routeTree.gen.ts",
      ],
      // Measured with the live PostgreSQL/RustFS suite; raise, never lower.
      thresholds: { statements: 73, branches: 64, functions: 68, lines: 74 },
    },
    environment: "node",
    globals: true,
  },
});
