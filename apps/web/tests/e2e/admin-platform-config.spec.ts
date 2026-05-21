import { expect, test, type Page } from "@playwright/test";
import { installCoreAppsRoutes } from "./support/api-fixtures";

type TierId = "personal" | "business" | "enterprise" | "sovereign";

interface PlatformConfigPatch {
  readonly security: {
    readonly tier: TierId;
  };
}

interface PlatformConfigPatchRequest {
  readonly body: PlatformConfigPatch;
  readonly method: string;
  readonly pathname: string;
}

test.describe("/settings/admin platform config", () => {
  test("sends the typed PATCH body and reflects a successful tier update", async ({ page }) => {
    const patchRequests: PlatformConfigPatchRequest[] = [];

    await mockPlatformConfig(page, {
      initialTier: "business",
      patchRequests,
      patchStatus: 200,
      patchedTier: "enterprise",
    });

    await page.goto("/settings/admin");
    await expect(page.getByText("Live platform config connected")).toBeVisible();

    await page.getByRole("button", { name: /Enterprise/ }).click();
    await page.getByRole("button", { name: "Apply tier draft" }).click();

    await expect(page.getByRole("heading", { name: "Enterprise platform state" })).toBeVisible();
    await expect(page.getByText("Live tier").locator("..")).toContainText("Enterprise");
    expect(patchRequests).toEqual([
      {
        method: "PATCH",
        pathname: "/api/admin/platform-config",
        body: { security: { tier: "enterprise" } },
      },
    ]);
  });

  test("sends the typed PATCH body and shows the mutation error state", async ({ page }) => {
    const patchRequests: PlatformConfigPatchRequest[] = [];

    await mockPlatformConfig(page, {
      initialTier: "business",
      patchRequests,
      patchStatus: 403,
      patchedTier: "business",
    });

    await page.goto("/settings/admin");
    await expect(page.getByText("Live platform config connected")).toBeVisible();

    await page.getByRole("button", { name: /Enterprise/ }).click();
    await page.getByRole("button", { name: "Apply tier draft" }).click();

    // Scope to the tier-draft mutation alert specifically: this spec only mocks
    // `/api/admin/platform-config`, so the other (un-mocked) admin panels render
    // their own `role="alert"` unavailable notices on the same page. A bare
    // `getByRole("alert")` would be a strict-mode violation against those.
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not apply the tier draft." }),
    ).toHaveText("Could not apply the tier draft.");
    await expect(page.getByRole("heading", { name: "Business platform state" })).toBeVisible();
    expect(patchRequests).toEqual([
      {
        method: "PATCH",
        pathname: "/api/admin/platform-config",
        body: { security: { tier: "enterprise" } },
      },
    ]);
  });
});

async function mockPlatformConfig(
  page: Page,
  options: {
    readonly initialTier: TierId;
    readonly patchRequests: PlatformConfigPatchRequest[];
    readonly patchStatus: number;
    readonly patchedTier: TierId;
  },
) {
  // The production shell calls GET /api/core-apps on mount; this spec's own
  // route matcher is narrower than `**/api/**`, so stub the core-app routes
  // explicitly with the shared valid fixtures to keep the shell from crashing.
  await installCoreAppsRoutes(page);

  await page.route("**/api/admin/platform-config", async (route) => {
    const request = route.request();

    if (request.method() === "PATCH") {
      options.patchRequests.push({
        body: (await request.postDataJSON()) as PlatformConfigPatch,
        method: request.method(),
        pathname: new URL(request.url()).pathname,
      });

      if (options.patchStatus >= 400) {
        await route.fulfill({
          status: options.patchStatus,
          contentType: "application/json",
          body: JSON.stringify({ error: "denied" }),
        });
        return;
      }

      await route.fulfill({
        status: options.patchStatus,
        contentType: "application/json",
        body: JSON.stringify(platformStatus(options.patchedTier, true)),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(platformStatus(options.initialTier, true)),
    });
  });
}

function platformStatus(tier: TierId, ready: boolean) {
  return {
    config: {
      security: { tier },
    },
    readiness: {
      ready,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: tier !== "personal",
          status: "ready",
          expected: { destinations: ["postgres", "immutable-s3"] },
          observed: { destinations: ["postgres", "immutable-s3"] },
        },
      ],
    },
  };
}
