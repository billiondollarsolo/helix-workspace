import { expect, test, type Page } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

/* Domains is now the single place a domain is registered, proved, and switched
   on for sending or receiving. It replaced three separate lists, so this spec
   drives the real page in a real browser — the route-level audits never open
   the per-domain disclosure where the capabilities live. */

function domainsPayload(overrides: Record<string, unknown> = {}) {
  return {
    domains: [
      {
        domain: {
          id: "d-1",
          orgId: "org-1",
          domain: "helix.test",
          isPrimary: true,
          verificationStatus: "verified",
          verifiedAt: "2026-01-02T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        dnsRecords: [],
        sending: null,
        receiving: null,
        ...overrides,
      },
    ],
  };
}

async function openDomains(page: Page, payload: unknown): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("helix.accessToken", "e2e-admin-token");
  });
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) {
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === "/api/admin/domains" ? payload : {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("/admin/domains");
}

test.describe("/admin/domains — capabilities", () => {
  test("says a proved domain is unused rather than implying it works", async ({ page }) => {
    await openDomains(page, domainsPayload());

    await expect(page.getByText("helix.test").first()).toBeVisible();
    await expect(page.getByText(/not used for anything yet/)).toBeVisible();
  });

  test("offers both capabilities on one page", async ({ page }) => {
    /* The whole point of the merge: sending and receiving used to be two tabs
       under Mail, unreachable from the domain they belong to. */
    await openDomains(page, domainsPayload());

    await expect(page.getByLabel("Turn on sending for helix.test")).toBeVisible();
    await expect(page.getByLabel("Turn on receiving for helix.test")).toBeVisible();
  });

  test("withholds the capabilities until ownership is proved", async ({ page }) => {
    await openDomains(
      page,
      domainsPayload({
        domain: {
          id: "d-1",
          orgId: "org-1",
          domain: "helix.test",
          isPrimary: true,
          verificationStatus: "pending",
          verifiedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    // Both the row summary and the ownership chip say it; assert each.
    await expect(page.getByText("Not proved", { exact: true })).toBeVisible();
    await expect(page.getByText(/no mail flows for this domain/)).toBeVisible();
    await expect(page.getByLabel("Turn on sending for helix.test")).toHaveCount(0);
    // The way forward is still on screen.
    await expect(page.getByLabel("Issue a verification record for helix.test")).toBeVisible();
  });

  test("warns before rotating a signing key", async ({ page }) => {
    await openDomains(
      page,
      domainsPayload({
        sending: {
          id: "s-1",
          isDefault: true,
          verifiedAt: "2026-01-03T00:00:00.000Z",
          dkimKeyCount: 1,
        },
      }),
    );

    await page.getByLabel("Rotate the DKIM key for helix.test").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("can fail DKIM");
  });
});
