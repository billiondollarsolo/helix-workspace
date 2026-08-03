import { expect, test, type Page } from "@playwright/test";
import { installCoreAppsRoutes } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const adminToken = "e2e-platform-config-token";

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

/** The admin sidebar. Scoped because the "related pages" chips inside a
 *  section are real links too, so an unscoped role=link query can match twice. */
function adminNav(page: Page) {
  return page.getByRole("navigation", { name: "Administration" });
}

test.describe("/admin platform config", () => {
  test("sends the typed PATCH body and reflects a successful tier update", async ({ page }) => {
    const patchRequests: PlatformConfigPatchRequest[] = [];

    await seedAdminToken(page);
    await mockPlatformConfig(page, {
      initialTier: "business",
      patchRequests,
      patchStatus: 200,
      patchedTier: "enterprise",
    });

    await page.goto("/admin");
    await adminNav(page).getByRole("link", { name: "Tier readiness", exact: true }).click();
    await expect(page.getByText("Live platform config connected")).toBeVisible();

    await page.getByRole("button", { name: /Enterprise/ }).click();
    await page.getByRole("button", { name: "Apply tier draft" }).click();
    /* Applying a tier is destructive — it sets the deployment's security tier
       whether or not the platform meets the gates — so it now routes through the
       shared confirmation dialog. This spec predates that. */
    await page.getByRole("button", { name: /^Apply (Enterprise|Business)$/ }).click();

    await expect(page.getByRole("heading", { name: "Enterprise platform state" })).toBeVisible();
    await expect(page.getByText("Live tier", { exact: true }).locator("..")).toContainText(
      "Enterprise",
    );
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

    await seedAdminToken(page);
    await mockPlatformConfig(page, {
      initialTier: "business",
      patchRequests,
      patchStatus: 403,
      patchedTier: "business",
    });

    await page.goto("/admin");
    await adminNav(page).getByRole("link", { name: "Tier readiness", exact: true }).click();
    await expect(page.getByText("Live platform config connected")).toBeVisible();

    await page.getByRole("button", { name: /Enterprise/ }).click();
    await page.getByRole("button", { name: "Apply tier draft" }).click();
    /* Applying a tier is destructive — it sets the deployment's security tier
       whether or not the platform meets the gates — so it now routes through the
       shared confirmation dialog. This spec predates that. */
    await page.getByRole("button", { name: /^Apply (Enterprise|Business)$/ }).click();

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

async function seedAdminToken(page: Page): Promise<void> {
  await page.addInitScript(({ key, token }) => window.localStorage.setItem(key, token), {
    key: accessTokenStorageKey,
    token: adminToken,
  });
}

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
