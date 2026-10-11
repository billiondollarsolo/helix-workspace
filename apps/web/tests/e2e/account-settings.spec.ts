import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

/* Settings → Security, App passwords, S3 access keys and Language & region
   against a small in-memory backend that keeps state between calls. */

test.beforeEach(() => {
  test.skip(isLiveBackend(), "Account settings use an isolated mock backend.");
});

const actorId = "00000000-0000-4000-8000-000000000111";
const now = new Date().toISOString();

interface Backend {
  readonly calls: { path: string; body: unknown }[];
}

async function mockAccountBackend(page: Page): Promise<Backend> {
  await seedBrowserSession(page, "account-settings-session");
  const calls: Backend["calls"] = [];
  let sessions = [
    session("this", true, "Chrome", "Linux", "desktop"),
    session("phone", false, "Safari", "iOS", "mobile"),
    session("tablet", false, "Firefox", "Android", "tablet"),
  ];
  let appPasswords: Record<string, unknown>[] = [];
  let s3Keys: Record<string, unknown>[] = [];
  let preferences: Record<string, unknown> = {
    language: null,
    timeZone: "UTC",
    dateFormat: null,
    timeFormat: null,
    weekStart: null,
    workingHours: null,
    mail: { readingPane: "none", density: "default", conversationView: true },
    updatedAt: null,
  };
  const tools: Record<string, (body: Record<string, unknown>) => unknown> = {
    "account.preferences.get": () => preferences,
    "account.preferences.set": (body) => {
      preferences = { ...preferences, ...body };
      return preferences;
    },
    "app.passwords.list": () => ({
      appPasswords,
      grantableScopes: ["mail.send", "calendar.read", "calendar.write", "drive.read"],
    }),
    "app.passwords.create": (body) => {
      const record = {
        id: `pw-${String(appPasswords.length + 1)}`,
        label: body.label,
        scopes: body.scopes,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: now,
      };
      appPasswords = [...appPasswords, record];
      return { appPassword: record, password: "wxyz-abcd-efgh-ijkl" };
    },
    "app.passwords.revoke": (body) => {
      appPasswords = appPasswords.filter((record) => record.id !== body.passwordId);
      return { status: "revoked" };
    },
    // This person holds Drive read and write but not drive.delete.
    "drive.s3-keys.list": () => ({
      accessKeys: s3Keys,
      endpointPath: "/v1/s3",
      grantableScopes: ["drive.read", "drive.write"],
    }),
    "drive.s3-keys.create": (body) => {
      const accessKey = {
        id: `key-${String(s3Keys.length + 1)}`,
        accessKeyId: "HLXE2EKEYAAAAAAAAAAA",
        label: body.label,
        scopes: body.scopes,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: now,
      };
      s3Keys = [...s3Keys, accessKey];
      return { accessKey, secretAccessKey: "e2e-s3-secret", endpointPath: "/v1/s3" };
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/v1/u, "");
    const body = parseBody(request.postData());
    if (request.method() === "POST") calls.push({ path, body });
    if (path === "/api/auth/get-session") {
      return json(route, {
        user: { id: "login-1", actorId, email: "lea@example.test", name: "Léa Nguyen" },
      });
    }
    if (path === "/api/auth/csrf-token") return json(route, { csrfToken: "e2e-csrf-token" });
    if (path === "/api/profile") {
      return json(route, {
        profile: {
          actorId,
          orgId: "org-1",
          email: "lea@example.test",
          displayName: "Léa Nguyen",
          pronouns: "",
          jobTitle: "",
          about: "",
          avatarDataUrl: null,
        },
      });
    }
    if (path === "/api/account/sessions") return json(route, { sessions });
    if (path === "/api/account/sessions/revoke-others") {
      const revoked = sessions.filter((entry) => !entry.current).length;
      sessions = sessions.filter((entry) => entry.current);
      return json(route, { revoked });
    }
    const revokeOne = /^\/api\/account\/sessions\/([^/]+)\/revoke$/u.exec(path);
    if (revokeOne !== null) {
      sessions = sessions.filter((entry) => entry.id !== revokeOne[1]);
      return json(route, { revoked: true });
    }
    if (path === "/api/account/password") {
      if (body.currentPassword !== "old-password") {
        return json(
          route,
          { error: { code: "bad_request", message: "Your current password is incorrect." } },
          400,
        );
      }
      if (body.revokeOtherSessions === true) sessions = sessions.filter((entry) => entry.current);
      return json(route, { changed: true });
    }
    const tool = /^\/api\/tools\/(.+)$/u.exec(path)?.[1];
    if (tool !== undefined && tool in tools) return json(route, tools[tool]?.(body));
    if (await fulfillCoreAppsRoute(route)) return;
    return json(route, {});
  });
  return { calls };
}

function session(
  id: string,
  current: boolean,
  browser: string,
  os: string,
  deviceType: "desktop" | "mobile" | "tablet",
) {
  return {
    id,
    current,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now,
    ipAddress: current ? "203.0.113.10" : null,
    userAgent: null,
    browser,
    os,
    deviceType,
  };
}

function parseBody(raw: string | null): Record<string, unknown> {
  try {
    return (JSON.parse(raw ?? "{}") ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

async function expectNoAxeViolations(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const browser = window as typeof window & { axe: typeof axe };
    const result = await browser.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
      },
    });
    return result.violations.map((violation) => violation.id);
  });
  expect(violations).toEqual([]);
}

test("change password checks the current password and signs out other devices", async ({
  page,
}) => {
  const backend = await mockAccountBackend(page);
  await page.goto("/mail?settings=security");
  const settings = settingsDialog(page);
  const devices = settings.getByRole("list", { name: "Signed-in devices" });
  await expect(devices.getByRole("listitem")).toHaveCount(3);

  await settings.getByLabel("Current password").first().fill("wrong-password");
  await settings.getByLabel("New password", { exact: true }).fill("a much longer passphrase");
  await settings.getByLabel("Confirm new password").fill("a much longer passphrase");
  await expect(settings.getByText("Strong password.")).toBeVisible();
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(settings.getByRole("alert")).toHaveText("Your current password is incorrect.");

  await settings.getByLabel("Current password").first().fill("old-password");
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(
    settings.getByText("Password changed. Your other devices were signed out."),
  ).toBeVisible();
  await expect(devices.getByRole("listitem")).toHaveCount(1);
  await expect(devices).toContainText("This device");
  expect(
    backend.calls.filter((call) => call.path === "/api/account/password").at(-1)?.body,
  ).toEqual({
    currentPassword: "old-password",
    newPassword: "a much longer passphrase",
    revokeOtherSessions: true,
  });
});

test("signs out one device, then every other device after confirming", async ({ page }) => {
  await mockAccountBackend(page);
  await page.goto("/mail?settings=security");
  const settings = settingsDialog(page);
  const devices = settings.getByRole("list", { name: "Signed-in devices" });
  await expect(devices.getByRole("listitem").first()).toContainText("Chrome on Linux");
  await expect(devices.getByRole("listitem").first()).toContainText("This device");
  await expectNoAxeViolations(page);

  await settings.getByRole("button", { name: "Sign out of Safari on iOS" }).click();
  await expect(devices.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("Signed out of Safari on iOS")).toBeVisible();

  await settings.getByRole("button", { name: "Sign out of all other devices" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Sign out of all other devices?" });
  await expect(confirm).toContainText("1 other device will need to sign in again.");
  await confirm.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(devices.getByRole("listitem")).toHaveCount(1);
  await expect(settings.getByRole("button", { name: "Sign out of all other devices" })).toHaveCount(
    0,
  );
});

test("creates an app password, shows it once, and revokes it", async ({ page }) => {
  const backend = await mockAccountBackend(page);
  await page.goto("/mail?settings=app-passwords");
  const settings = settingsDialog(page);
  await expect(settings.getByText("No app passwords yet")).toBeVisible();
  await expect(settings.getByLabel("Sync your contacts (CardDAV)")).toHaveCount(0);

  await settings.getByLabel("App or device name").fill("Phone calendar");
  await settings.getByLabel("Sync your calendar (CalDAV)").check();
  await settings.getByRole("button", { name: "Create password" }).click();
  const secret = page.getByRole("dialog", { name: "Your app password" });
  await expect(secret.getByLabel("App password")).toHaveText("wxyz-abcd-efgh-ijkl");
  await expect(secret).toContainText("/v1/dav/cal/");
  await expect(secret).toContainText("lea@example.test");
  await expectNoAxeViolations(page);
  await secret.getByRole("button", { name: "Done" }).click();
  await expect(secret).toHaveCount(0);
  expect(
    backend.calls.find((call) => call.path === "/api/tools/app.passwords.create")?.body,
  ).toEqual({ label: "Phone calendar", scopes: ["calendar.read", "calendar.write"] });

  const list = settings.getByRole("list", { name: "App passwords" });
  await expect(list).toContainText("Phone calendar");
  await expect(list).toContainText("Never used");
  await expect(list).not.toContainText("wxyz-abcd-efgh-ijkl");
  await settings.getByRole("button", { name: "Revoke Phone calendar" }).click();
  await page
    .getByRole("alertdialog", { name: "Revoke “Phone calendar”?" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(settings.getByText("No app passwords yet")).toBeVisible();
});

test("offers an S3 key only the Drive scopes the person holds", async ({ page }) => {
  const backend = await mockAccountBackend(page);
  await page.goto("/mail?settings=s3-keys");
  const settings = settingsDialog(page);
  const scopes = settings.getByRole("group", { name: "Scopes" });
  await expect(scopes.getByRole("checkbox", { name: "Read (list and download)" })).toBeChecked();
  await expect(scopes.getByRole("checkbox", { name: "Write (upload and copy)" })).toBeChecked();
  await expect(scopes.getByRole("checkbox")).toHaveCount(2);
  await expect(settings.getByText("Delete (move to trash)")).toHaveCount(0);

  await settings.getByLabel("New key").fill("Home NAS");
  await settings.getByRole("button", { name: "Create access key" }).click();
  await expect(settings.getByRole("region", { name: "New S3 access key" })).toContainText(
    "e2e-s3-secret",
  );
  expect(
    backend.calls.find((call) => call.path === "/api/tools/drive.s3-keys.create")?.body,
  ).toEqual({ label: "Home NAS", scopes: ["drive.read", "drive.write"] });
  await expectNoAxeViolations(page);
});

test("saves language and region choices and formats times with them", async ({ page }) => {
  const backend = await mockAccountBackend(page);
  await page.goto("/mail?settings=language");
  const settings = settingsDialog(page);
  const language = settings.getByRole("combobox", { name: "Language", exact: true });
  await expect(language).toHaveValue("en");
  await expect(language.locator("option")).toHaveCount(1);

  const zone = settings.getByRole("combobox", { name: "Time zone" });
  await zone.fill("tokyo");
  await settings.getByRole("option", { name: /Asia\/Tokyo/u }).click();
  await expect(zone).toHaveValue("(GMT+09:00) Asia/Tokyo");
  await settings
    .getByRole("group", { name: "Time format" })
    .getByLabel(/^24-hour/u)
    .check();
  await settings.getByLabel("Start of week").selectOption("1");
  await settings.getByLabel("Show my working hours").check();
  await settings.getByLabel("Friday").uncheck();
  await settings.getByLabel("Start", { exact: true }).fill("08:30");
  await settings.getByLabel("End", { exact: true }).fill("16:30");
  await settings.getByRole("button", { name: "Save working hours" }).click();
  await expect(settings.getByRole("status").last()).toHaveText("Working hours saved.");

  const sets = backend.calls
    .filter((call) => call.path === "/api/tools/account.preferences.set")
    .map((call) => call.body);
  expect(sets).toEqual([
    { timeZone: "Asia/Tokyo" },
    { timeFormat: "24h" },
    { weekStart: 1 },
    {
      workingHours: {
        enabled: true,
        days: [1, 2, 3, 4].map((day) => ({ day, start: "08:30", end: "16:30" })),
      },
    },
  ]);
  // The home card reads the saved zone and clock through the shared formatter.
  await settings.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(settings.getByText("Asia/Tokyo · 24-hour clock")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("settings search finds individual settings", async ({ page }) => {
  await mockAccountBackend(page);
  await page.goto("/chat?settings=profile");
  const settings = settingsDialog(page);
  await settings.getByRole("searchbox", { name: "Search settings" }).fill("working hours");
  await expect(settings.getByRole("navigation").getByRole("status")).toHaveText("1 section found");
  await settings
    .getByRole("navigation")
    .getByRole("button", { name: /Language & region/u })
    .click();
  await expect(page).toHaveURL(/settings=language/u);
  await expect(settings.getByRole("heading", { name: "Working hours" })).toBeVisible();
});

test("deep links open the section on any app and survive in-app navigation", async ({ page }) => {
  await mockAccountBackend(page);
  await page.goto("/mail?settings=mail/filters");
  const settings = settingsDialog(page);
  await expect(
    settings.getByRole("tab", { name: "Filters and blocked addresses" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/settings=mail%2Ffilters|settings=mail\/filters/u);
  await page.goto("/calendar?settings=security");
  await expect(settingsDialog(page).getByRole("heading", { name: "Security" })).toBeVisible();
  await page.goBack();
  await expect(
    settingsDialog(page).getByRole("tab", { name: "Filters and blocked addresses" }),
  ).toBeVisible();
});

test("on a phone, settings open on the section list and each section has a back button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAccountBackend(page);
  await page.goto("/mail");
  await page.goto("/mail?settings=profile");
  const settings = settingsDialog(page);
  const nav = settings.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  await expect(settings.getByRole("heading", { name: /^Welcome/u })).toBeHidden();
  await nav.getByRole("button", { name: "Security", exact: true }).click();
  await expect(nav).toBeHidden();
  const heading = settings.getByRole("heading", { name: "Security", level: 1 });
  await expect(heading).toBeVisible();
  // The section uses the full width instead of sharing it with the nav.
  const width = await heading.evaluate((node) => node.closest("section")?.clientWidth ?? 0);
  expect(width).toBeGreaterThan(350);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await expectNoAxeViolations(page);
  await settings.getByRole("button", { name: "All settings" }).click();
  await expect(nav).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toHaveCount(0);
});
