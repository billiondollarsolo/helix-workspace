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
