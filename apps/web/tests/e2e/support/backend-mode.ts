import type { Page } from "@playwright/test";

/**
 * Shared E2E backend-mode helper (P1-1, PRD alignment plan 2026-05-21).
 *
 * The feature E2E specs in this directory run in two modes:
 *
 *  - MOCKED (default): Playwright `page.route` intercepts every `/v1/api/**` call
 *    and serves deterministic fixtures. This runs anywhere — locally and in CI —
 *    against the real, production web UI served by Vite. It exercises real
 *    routing, rendering, hydration and accessibility of each feature shell.
 *
 *  - LIVE: when `HELIX_E2E_BACKEND=live` is set, the specs DO NOT install route
 *    mocks and instead drive the real Helix API. The CI `e2e` job
 *    (.github/workflows/e2e.yml) brings the backend up via docker-compose
 *    (Postgres, Redis, NATS, Meilisearch, RustFS, Cerbos, Mailpit) and exports
 *    `HELIX_E2E_BACKEND=live` plus `HELIX_E2E_API_BASE_URL` so the same specs
 *    become true end-to-end tests with zero in-memory fakes.
 *
 * Keeping both modes in one spec file means the assertions are written once and
 * stay honest: the mocked run is the regression gate, the live run is the real
 * PRD §13 "one source, three surfaces" proof.
 */

type BackendMode = "mocked" | "live";

/** Resolve the backend mode from the environment. Defaults to `mocked`. */
function backendMode(): BackendMode {
  return process.env.HELIX_E2E_BACKEND === "live" ? "live" : "mocked";
}

export function isLiveBackend(): boolean {
  return backendMode() === "live";
}

/** Establish the same cookie session used by the web login flow. */
export async function seedBrowserSession(page: Page, mockToken: string): Promise<string> {
  const baseUrl = process.env.HELIX_E2E_WEB_BASE_URL ?? "http://127.0.0.1:4173";
  if (!isLiveBackend()) {
    await page.context().addCookies([{ name: "helix_session", value: mockToken, url: baseUrl }]);
    return mockToken;
  }
  const csrf = await page.request.get(`${baseUrl}/v1/api/auth/csrf-token`);
  const payload = (await csrf.json()) as { readonly csrfToken?: string };
  if (!csrf.ok() || typeof payload.csrfToken !== "string")
    throw new Error("Live CSRF session setup failed.");
  const response = await page.request.post(`${baseUrl}/v1/api/auth/sign-in/email`, {
    headers: { origin: baseUrl, "x-helix-csrf-token": payload.csrfToken },
    data: {
      email: process.env.HELIX_E2E_EMAIL ?? "user@helix.local",
      password: process.env.HELIX_E2E_PASSWORD ?? "helix-user-password",
    },
  });
  if (!response.ok())
    throw new Error(
      `Live browser sign-in failed (${String(response.status())}). Seed login accounts or set HELIX_E2E_EMAIL/PASSWORD.`,
    );
  const session = await page.request.get(`${baseUrl}/v1/api/auth/get-session`);
  const identity = (await session.json()) as { readonly user?: { readonly id?: string } };
  if (!session.ok() || typeof identity.user?.id !== "string")
    throw new Error("Live browser sign-in did not establish a session.");
  return "live-cookie-session";
}
