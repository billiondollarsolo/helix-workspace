/**
 * Shared E2E backend-mode helper (P1-1, PRD alignment plan 2026-05-21).
 *
 * The feature E2E specs in this directory run in two modes:
 *
 *  - MOCKED (default): Playwright `page.route` intercepts every `/api/**` call
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

export type BackendMode = "mocked" | "live";

/** Resolve the backend mode from the environment. Defaults to `mocked`. */
export function backendMode(): BackendMode {
  return process.env.HELIX_E2E_BACKEND === "live" ? "live" : "mocked";
}

export function isLiveBackend(): boolean {
  return backendMode() === "live";
}

/**
 * Base URL of the real Helix API in live mode. The docker-compose stack
 * publishes the API on `HELIX_PORT` (default 28431); CI passes this through as
 * `HELIX_E2E_API_BASE_URL`.
 */
export function liveApiBaseUrl(): string {
  return process.env.HELIX_E2E_API_BASE_URL ?? "http://127.0.0.1:28431";
}

/**
 * OAuth client-credentials used to mint a real access token against the live
 * backend. These match the local dev client seeded by docker-compose.
 */
export function liveOAuthClient(): { readonly clientId: string; readonly clientSecret: string } {
  return {
    clientId: process.env.HELIX_E2E_CLIENT_ID ?? "helix-local-oauth-client",
    clientSecret: process.env.HELIX_E2E_CLIENT_SECRET ?? "helix-local-dev-secret",
  };
}

/**
 * Mint a real OAuth access token from the live backend so a spec can seed
 * `localStorage` exactly as the login flow would. Throws if the exchange fails
 * so a misconfigured live run fails loud instead of silently mocking nothing.
 */
export async function mintLiveAccessToken(scope: string): Promise<string> {
  const { clientId, clientSecret } = liveOAuthClient();
  const response = await fetch(`${liveApiBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Live OAuth token exchange failed with ${String(response.status)}: ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as { readonly access_token?: string };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Live OAuth token exchange returned no access_token.");
  }
  return payload.access_token;
}
