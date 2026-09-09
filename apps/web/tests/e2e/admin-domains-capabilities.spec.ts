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
          status: "verified",
          verifiedAt: "2026-01-02T00:00:00.000Z",
          identityEnabled: false,
          mailEnabled: false,
          aliasesEnabled: false,
          customHostEnabled: false,
          federationEnabled: false,
          providerId: null,
          identityMode: "secondary",
          aliasTargetDomainId: null,
          verificationHost: "_helix-verification.helix.test",
          verificationValue: "proof",
          verificationExpiresAt: "2027-01-01T00:00:00.000Z",
          verificationAttempts: 0,
          verificationLastAttemptAt: null,
          quarantinedAt: null,
          releasedAt: null,
          claimableAfter: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ...overrides,
        },
        dnsRecords: [],
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
    const body = pathname === "/v1/api/admin/domains" ? payload : {};
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
    await expect(page.getByText(/not used for anything yet/).first()).toBeVisible();
  });

  test("offers both capabilities on one page", async ({ page }) => {
    /* The whole point of the merge: sending and receiving used to be two tabs
       under Mail, unreachable from the domain they belong to. */
    await openDomains(page, domainsPayload());

    await expect(page.getByRole("checkbox", { name: "Mail", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Identity", exact: true })).toBeVisible();
  });

  test("withholds the capabilities until ownership is proved", async ({ page }) => {
    await openDomains(page, domainsPayload({ status: "pending", verifiedAt: null }));

    // Both the row summary and the ownership chip say it; assert each.
    await expect(page.getByText("Not proved", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Ownership is not proved, so capabilities are disabled/).first(),
    ).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Mail", exact: true })).toHaveCount(0);
    // The way forward is still on screen.
    await expect(page.getByLabel("Rotate verification record for helix.test")).toBeVisible();
  });

  test("warns before disabling mail", async ({ page }) => {
    await openDomains(page, domainsPayload({ mailEnabled: true }));
    await page.getByRole("checkbox", { name: "Mail", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("stops accepting and sending mail");
  });
});
