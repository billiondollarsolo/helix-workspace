import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration.
 *
 * The specs in `tests/e2e` run in two modes (see `tests/e2e/support/backend-mode.ts`):
 *
 *  - MOCKED (default): the real production web UI is served by Vite and every
 *    `/api/**` call is intercepted with deterministic fixtures. Runs anywhere,
 *    including the `e2e` CI job's mocked matrix leg.
 *  - LIVE (`HELIX_E2E_BACKEND=live`): the same UI is served by Vite but talks to
 *    a real Helix backend brought up via docker-compose. Set
 *    `HELIX_E2E_API_BASE_URL` (and optionally `HELIX_E2E_CLIENT_ID/SECRET`,
 *    `HELIX_E2E_MAILPIT_*`) so specs mint real OAuth tokens and exercise the
 *    live tools. CI wiring: `.github/workflows/e2e.yml`.
 *
 * The web app itself is always served locally on 4173; only the backend the UI
 * calls differs between modes.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.HELIX_E2E_WEB_BASE_URL ?? "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
