import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

/* Passwords is an optional install: the launcher offers it only where the
   deployment runs a password manager and an administrator turned it on. */

test.beforeEach(() =>
  test.skip(isLiveBackend(), "The live test backend does not install a password manager."),
);

const VAULT_URL = "https://vault.example.test";

interface Deployment {
  readonly installed: boolean;
  enabled: boolean;
  flagUpdates: unknown[];
}

async function openWorkspace(
  page: Page,
  path: string,
  start: Pick<Deployment, "installed" | "enabled">,
): Promise<Deployment> {
  const deployment: Deployment = { ...start, flagUpdates: [] };
  const tenantConfig = () => {
    const features = { passwords_app: deployment.enabled };
    return {
      tenantConfig: {
        orgId: "22222222-2222-4222-8222-222222222222",
        orgName: "Example",
        byo: {},
        features,
        quotas: {},
        branding: {},
        effective: { byo: {}, features, quotas: {}, branding: {} },
      },
    };
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/api/core-apps") {
      return route.fulfill({
        json: {
          role: "all-in-one",
          apps: ["mail", "calendar", "drive", "chat"].map((id) => ({
            id,
            name: id,
            enabled: true,
            registered: true,
          })),
          passwords: {
            installed: deployment.installed,
            enabled: deployment.enabled,
            url: deployment.installed && deployment.enabled ? VAULT_URL : null,
          },
        },
      });
    }
    if (pathname === "/v1/api/admin/tenant-config") {
      if (request.method() === "PATCH") {
        const update = request.postDataJSON() as { features: { passwords_app: boolean } };
        deployment.flagUpdates.push(update);
        deployment.enabled = update.features.passwords_app;
      }
      return route.fulfill({ json: tenantConfig() });
    }
    if (await fulfillCoreAppsRoute(route)) return;
    return route.fulfill({ json: {} });
  });
  await page.goto(path);
  return deployment;
}

async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
          },
        })
      ).violations,
  );
  expect(violations).toEqual([]);
}

async function launcherNames(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "Helix apps" }).click();
  const launcher = page.getByRole("menu", { name: "Helix apps" });
  await expect(launcher).toBeVisible();
  const names = (await launcher.getByRole("menuitem").allTextContents()).map((name) => name.trim());
  await page.keyboard.press("Escape");
  return names;
}

test("opens the password manager and gives the address its apps ask for", async ({ page }) => {
  await openWorkspace(page, "/passwords", { installed: true, enabled: true });
  const main = page.getByRole("main", { name: "Passwords" });

  const open = main.getByRole("link", { name: /Open Passwords/u });
  await expect(open).toHaveAttribute("href", VAULT_URL);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  await expect(main).toContainText("Nobody, including your administrators, can recover it");
  await expect(main.getByText(VAULT_URL, { exact: true })).toBeVisible();
  await audit(page);

  expect(await launcherNames(page)).toContain("Passwords");
  const railLink = page.getByRole("navigation", { name: "Apps", exact: true }).getByRole("link", {
    name: "Passwords",
    exact: true,
  });
  await expect(railLink).toHaveAttribute("href", "/passwords");
  await expect(railLink).toHaveAttribute("aria-current", "page");
});

test("stays out of the launcher until it is installed and turned on", async ({ page }) => {
  await openWorkspace(page, "/passwords", { installed: true, enabled: false });
  await expect(page.getByRole("heading", { name: "Passwords isn't available" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open Passwords/u })).toHaveCount(0);
  expect(await launcherNames(page)).not.toContain("Passwords");
  await expect(
    page.getByRole("navigation", { name: "Apps", exact: true }).getByRole("link", {
      name: "Passwords",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("an administrator turns Passwords on where the server installed it", async ({ page }) => {
  const deployment = await openWorkspace(page, "/admin/passwords", {
    installed: true,
    enabled: false,
  });
  const server = page.getByRole("region", { name: "Password manager" });
  await expect(server).toContainText("Installed");
  expect(await launcherNames(page)).not.toContain("Passwords");

  await page
    .getByRole("region", { name: "Availability" })
    .getByRole("switch", { name: "Passwords is on for everyone" })
    .click();
  await expect
    .poll(() => deployment.flagUpdates)
    .toEqual([
      { features: { passwords_app: true }, reason: "admin settings update: passwords_app" },
    ]);
  await expect.poll(() => launcherNames(page)).toContain("Passwords");
  await expect(
    page.getByRole("navigation", { name: "Apps", exact: true }).getByRole("link", {
      name: "Passwords",
      exact: true,
    }),
  ).toBeVisible();
  await audit(page);
});

test("says so when the server did not install a password manager", async ({ page }) => {
  await openWorkspace(page, "/admin/passwords", { installed: false, enabled: false });
  const server = page.getByRole("region", { name: "Password manager" });
  await expect(server).toContainText("Not installed");
  await expect(server).toContainText("Optional installs");
  await expect(page.getByRole("region", { name: "Availability" })).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`offers Passwords in phone More navigation (${colorScheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await openWorkspace(page, "/mail", { installed: true, enabled: true });
    await page
      .getByRole("navigation", { name: "Apps", exact: true })
      .getByRole("button", { name: "More" })
      .click();
    const more = page.getByRole("dialog", { name: "More", exact: true });
    const passwords = more.getByRole("link", { name: "Passwords", exact: true });
    await expect(passwords).toHaveAttribute("href", "/passwords");
    await audit(page);
    await passwords.click();
    await expect(page).toHaveURL(/\/passwords$/u);
    await expect(page.getByRole("heading", { name: "Passwords", exact: true })).toBeVisible();
    await expect(more).toHaveCount(0);
    await audit(page);
  });
}
