import { defineConfig } from "@playwright/test";

/**
 * Opt-in release gate for a real Helix/Jitsi/JVB/Jibri deployment. It is kept
 * separate from the mocked product E2E suite so missing media infrastructure
 * is a hard failure, never a skip or a mocked success.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "meet-live-media.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: "list",
  outputDir: "test-results/meet-live",
  use: {
    headless: true,
    ignoreHTTPSErrors: false,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  projects: [{ name: "chromium-live-media", use: { browserName: "chromium" } }],
});
