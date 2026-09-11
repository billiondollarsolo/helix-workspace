import { expect, test } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

test.beforeEach(() => test.skip(isLiveBackend(), "Session expiry uses an isolated mock backend."));

test("re-verifies an expired admin session once and returns to the requested page", async ({
  page,
}) => {
  await seedBrowserSession(page, "expired-admin-session");
  let signedIn = false;
  let rejectedRequests = 0;
  let loginVisits = 0;
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      new URL(request.url()).pathname === "/login"
    )
      loginVisits += 1;
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/api/auth/sign-in/email") {
      signedIn = true;
      return route.fulfill({
        json: {
          user: {
            id: "admin",
            actorId: "00000000-0000-4000-8000-000000000111",
            email: "admin@example.test",
            name: "Avery Park",
          },
        },
      });
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/v1/api/admin/users") {
      if (!signedIn) {
        rejectedRequests += 1;
        return route.fulfill({
          status: 401,
          json: {
            error: {
              code: "session_reauthentication_required",
              message: "Your session must be verified again. Sign in again to continue.",
            },
          },
        });
      }
      return route.fulfill({ json: { users: [], nextCursor: null } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/users#directory");
  await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Your session must be verified again");
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get("returnTo")).toBe("/admin/users#directory");
  expect(rejectedRequests).toBe(1);
  expect(loginVisits).toBe(1);
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(
      async () =>
        (
          await (window as typeof window & { axe: typeof axe }).axe.run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
            },
          })
        ).violations,
    ),
  ).toEqual([]);
  await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users#directory$/u);
  await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toHaveCount(0);
  expect(rejectedRequests).toBe(1);
});

test("keeps a genuine permission denial on the page without a login loop", async ({ page }) => {
  await seedBrowserSession(page, "denied-admin-session");
  let requests = 0;
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    if (new URL(route.request().url()).pathname === "/v1/api/admin/users") {
      requests += 1;
      return route.fulfill({
        status: 403,
        json: { error: { code: "forbidden", message: "Denied for this role." } },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/users");
  await expect(page.getByText("Admin users failed with 403")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  // Existing directory loader prefetches once; the mounted query reports the denial once.
  expect(requests).toBe(2);
});

test("keeps the session and unsent Assistant draft through a backend restart and recovers", async ({
  page,
}) => {
  await seedBrowserSession(page, "restart-safe-session");
  const cookies = await page.context().cookies();
  let down = false;
  let expired = false;
  let failedSessions = 0;
  let recoveredSessions = 0;
  let failedLists = 0;
  const now = Date.now();
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/auth/get-session")) {
      if (down) {
        failedSessions += 1;
        return route.fulfill({ status: 502, body: "Bad Gateway" });
      }
      if (expired) return route.fulfill({ status: 401, json: { error: { code: "unauthorized" } } });
      recoveredSessions += 1;
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname.endsWith("/assistant.conversations.list")) {
      if (down) {
        failedLists += 1;
        return route.fulfill({ status: 502, body: "Bad Gateway" });
      }
      return route.fulfill({
        json: {
          items: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              title: recoveredSessions > 1 ? "Recovered chat" : "Saved chat",
              pinned: false,
              updatedAt: new Date(now).toISOString(),
            },
          ],
          nextCursor: null,
        },
      });
    }
    if (pathname.endsWith("/assistant.models.list"))
      return route.fulfill({
        json: {
          models: [{ id: "groq/llama", label: "Llama", providerId: "groq", model: "llama" }],
        },
      });
    if (pathname.endsWith("/api/profile"))
      return route.fulfill({
        status: down ? 502 : 200,
        json: {
          profile: {
            actorId: "00000000-0000-4000-8000-000000000111",
            orgId: "00000000-0000-4000-8000-000000000100",
            email: "admin@example.test",
            displayName: "Test admin",
            pronouns: "",
            jobTitle: "",
            about: "",
          },
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/assistant");
  const composer = page.getByRole("textbox", { name: "Message Helix AI" });
  await composer.fill("Keep this unsent message while the backend restarts.");
  await expect(page.getByTestId("assistant-thread-list")).toContainText("Saved chat");
  down = true;
  await page.clock.setSystemTime(new Date(now + 31_000));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/assistant\?settings=profile/u);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => failedSessions).toBeGreaterThan(0);
  await expect.poll(() => failedLists).toBeGreaterThan(0);
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(composer).toHaveValue("Keep this unsent message while the backend restarts.");
  await expect(
    page.getByRole("heading", { name: "What can I help you with, Test admin?" }),
  ).toBeVisible();
  await expect(page.getByTestId("assistant-thread-list")).toContainText("Saved chat");
  await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "We couldn’t load this view" })).toHaveCount(0);
  down = false;
  await page.clock.setSystemTime(new Date(now + 62_000));
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => recoveredSessions).toBeGreaterThan(1);
  await expect(page.getByTestId("assistant-thread-list")).toContainText("Recovered chat");
  await expect(composer).toHaveValue("Keep this unsent message while the backend restarts.");
  expect(await page.context().cookies()).toEqual(cookies);
  expired = true;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/assistant");
});

test("Retry reloads a failed cold session lookup after the backend recovers", async ({ page }) => {
  await seedBrowserSession(page, "cold-restart-session");
  const cookies = await page.context().cookies();
  let ready = false;
  let lookups = 0;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/auth/get-session")) {
      lookups += 1;
      if (!ready) return route.fulfill({ status: 503, body: "Service temporarily unavailable" });
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname.endsWith("/assistant.conversations.list"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (pathname.endsWith("/assistant.models.list"))
      return route.fulfill({
        json: {
          models: [{ id: "groq/llama", label: "Llama", providerId: "groq", model: "llama" }],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { name: "We couldn’t load this view" })).toBeVisible();
  await expect(page).toHaveURL(/\/assistant$/u);
  expect(lookups).toBe(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => lookups).toBe(2);
  await expect(page.getByRole("heading", { name: "We couldn’t load this view" })).toBeVisible();
  ready = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Helix AI" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What can I help you with, Test admin?" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/assistant$/u);
  expect(lookups).toBe(3);
  await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toHaveCount(0);
  expect(await page.context().cookies()).toEqual(cookies);
});

for (const rejection of ["401", "null"] as const) {
  test(`background session ${rejection} hides the workspace and returns to sign-in`, async ({
    page,
  }) => {
    await seedBrowserSession(page, "expired-background-session");
    let expired = false;
    let rejected = 0;
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/auth/get-session") && expired) {
        rejected += 1;
        return route.fulfill(
          rejection === "401"
            ? { status: 401, json: { error: { code: "unauthorized" } } }
            : { json: null },
        );
      }
      if (await fulfillCoreAppsRoute(route)) return;
      if (pathname.endsWith("/assistant.conversations.list"))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      if (pathname.endsWith("/assistant.models.list"))
        return route.fulfill({
          json: {
            models: [{ id: "groq/llama", label: "Llama", providerId: "groq", model: "llama" }],
          },
        });
      return route.fulfill({ json: {} });
    });
    await page.goto("/assistant#draft");
    await expect(page.getByRole("textbox", { name: "Message Helix AI" })).toBeVisible();
    expired = true;
    await page.clock.setSystemTime(new Date(Date.now() + 31_000));
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Helix AI" })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/assistant#draft");
    expect(rejected).toBe(2); // Background rejection, then login's own session lookup.
  });
}
