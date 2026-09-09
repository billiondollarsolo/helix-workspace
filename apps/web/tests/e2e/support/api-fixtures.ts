/**
 * Shared E2E API fixtures + route helpers.
 *
 * Every mocked spec drives the real production web shell, which on mount issues
 * a `GET /api/core-apps` request (see `coreAppsShellQueryOptions`) to decide
 * which left-rail items to gate. Specs that did not stub this route served the
 * catch-all `{}` body — a malformed `CoreAppShellStatus` — which previously
 * crashed the whole shell. This module provides one canonical, valid fixture
 * and a route installer so every mocked spec renders a healthy shell.
 */
import type { Page, Route } from "@playwright/test";

/** A well-formed `CoreAppShellStatus` body for `GET /api/core-apps`. */
export function coreAppShellStatusFixture() {
  const apps = [
    { id: "mail", name: "Mail" },
    { id: "chat", name: "Chat" },
    { id: "drive", name: "Drive" },
    { id: "calendar", name: "Calendar" },
    { id: "meet", name: "Meet" },
    { id: "assistant", name: "Assistant" },
  ] as const;
  return {
    role: "all-in-one",
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      enabled: true,
      registered: true,
    })),
  };
}

/** A well-formed `CoreAppsAdminStatus` body for `GET /api/admin/core-apps`. */
export function coreAppsAdminStatusFixture() {
  const base = coreAppShellStatusFixture();
  return {
    role: base.role,
    apps: base.apps.map((app) => ({
      id: app.id,
      name: app.name,
      description: `${app.name} core app`,
      enabled: true,
      inRole: true,
      registered: true,
    })),
  };
}

/**
 * True for the shell core-app routes that every mocked spec must answer with a
 * valid fixture regardless of the feature under test.
 */
export function isCoreAppsPath(pathname: string): boolean {
  return pathname === "/v1/api/core-apps" || pathname === "/v1/api/admin/core-apps";
}

/**
 * Fulfill a `/v1/api/core-apps` (or `/v1/api/admin/core-apps`) route with the shared
 * valid fixture. Returns `true` if it handled the route, `false` otherwise so
 * callers can fall through to their feature-specific mocks.
 */
export async function fulfillCoreAppsRoute(route: Route): Promise<boolean> {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/v1/api/auth/get-session") {
    await fulfillJson(route, {
      user: {
        id: "e2e-user",
        actorId: "00000000-0000-4000-8000-000000000111",
        email: "admin@example.test",
        name: "Test admin",
      },
    });
    return true;
  }
  if (pathname === "/v1/api/auth/csrf-token") {
    await fulfillJson(route, { csrfToken: "e2e-csrf-token" });
    return true;
  }
  if (pathname === "/v1/api/core-apps") {
    await fulfillJson(route, coreAppShellStatusFixture());
    return true;
  }
  if (pathname === "/v1/api/admin/core-apps") {
    await fulfillJson(route, coreAppsAdminStatusFixture());
    return true;
  }
  return false;
}

/**
 * Install a standalone route for the core-app shell endpoints. Use this in
 * specs whose own `page.route` matcher is narrower than `**\/api/**` and would
 * otherwise let `/v1/api/core-apps` reach a real (or non-existent) backend.
 */
export async function installCoreAppsRoutes(page: Page): Promise<void> {
  await page.route("**/api/auth/get-session", async (route) => {
    await fulfillCoreAppsRoute(route);
  });
  await page.route("**/api/auth/csrf-token", async (route) => {
    await fulfillCoreAppsRoute(route);
  });
  await page.route("**/api/core-apps", async (route) => {
    await fulfillJson(route, coreAppShellStatusFixture());
  });
  await page.route("**/api/admin/core-apps", async (route) => {
    await fulfillJson(route, coreAppsAdminStatusFixture());
  });
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
