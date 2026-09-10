import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const initialProfile = {
  actorId: "00000000-0000-4000-8000-000000000111",
  orgId: "00000000-0000-4000-8000-000000000100",
  email: "morgan@example.test",
  displayName: "Morgan Lee",
  pronouns: "they/them",
  jobTitle: "Engineer",
  about: "Building the workspace.",
};
const editedFields = {
  displayName: "Morgan Quinn",
  pronouns: "she/they",
  jobTitle: "Engineering lead",
  about: "",
};

test.beforeEach(() => {
  test.skip(isLiveBackend(), "Admin profile fault injection uses an isolated mock backend.");
});

test("admin edits human profiles with recoverable errors and persisted directory updates", async ({
  page,
}) => {
  const updates = await mockAdminProfiles(page, true);
  await page.goto("/admin/users");
  await expect(page.getByRole("button", { name: /^Edit profile for / })).toHaveCount(1);
  await page.getByRole("button", { name: "Edit profile for Morgan Lee", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit profile for Morgan Lee", exact: true });
  await expect(dialog.getByLabel("Display name", { exact: true })).toHaveValue("Morgan Lee");
  await expect(dialog.locator('input[name="email"], input[name="role"]')).toHaveCount(0);
  await dialog.getByLabel("Display name", { exact: true }).fill(editedFields.displayName);
  await dialog.getByLabel("Pronouns", { exact: true }).fill(editedFields.pronouns);
  await dialog.getByLabel("Job title", { exact: true }).fill(editedFields.jobTitle);
  await dialog.getByLabel("About", { exact: true }).fill(editedFields.about);
  await dialog.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Profile editing is temporarily unavailable.");
  await expect(dialog.getByLabel("Display name", { exact: true })).toHaveValue("Morgan Quinn");
  await dialog.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(updates).toEqual([editedFields, editedFields]);
  await expect(
    page.getByRole("button", { name: "Edit profile for Morgan Quinn", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Edit profile for Morgan Quinn", exact: true }).click();
  const reopened = page.getByRole("dialog", { name: "Edit profile for Morgan Quinn", exact: true });
  for (const [label, value] of [
    ["Display name", editedFields.displayName],
    ["Pronouns", editedFields.pronouns],
    ["Job title", editedFields.jobTitle],
    ["About", editedFields.about],
  ] as const) {
    await expect(reopened.getByLabel(label, { exact: true })).toHaveValue(value);
  }
});

test("admin profile dialog is accessible on mobile and restores keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdminProfiles(page);
  await page.goto("/admin/users");
  const opener = page.getByRole("button", { name: "Edit profile for Morgan Lee", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Edit profile for Morgan Lee", exact: true });
  const displayName = dialog.getByLabel("Display name", { exact: true });
  await expect(displayName).toHaveValue("Morgan Lee");
  await displayName.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(displayName).toBeFocused();
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const browser = window as typeof window & { axe: typeof axe };
    const result = await browser.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
      },
    });
    return result.violations;
  });
  expect(violations).toEqual([]);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

async function mockAdminProfiles(page: Page, failFirstSave = false): Promise<unknown[]> {
  await seedBrowserSession(page, "admin-profile-session");
  let profile = { ...initialProfile };
  const updates: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/v1/api/admin/users") {
      const users = [
        { id: profile.actorId, type: "user", displayName: profile.displayName },
        { id: "00000000-0000-4000-8000-000000000112", type: "agent", displayName: "Helper agent" },
        {
          id: "00000000-0000-4000-8000-000000000113",
          type: "service",
          displayName: "Mail service",
        },
        { id: "00000000-0000-4000-8000-000000000114", type: "system", displayName: "System" },
      ].map((user) => ({
        ...user,
        orgId: profile.orgId,
        email: user.type === "user" ? profile.email : null,
        scopes: [],
        disabledAt: null,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      }));
      await route.fulfill({ json: { users, nextCursor: null } });
      return;
    }
    if (pathname === `/v1/api/admin/users/${profile.actorId}/profile`) {
      if (request.method() === "PATCH") {
        expect(request.headers()["x-helix-csrf-token"]).toBe("e2e-csrf-token");
        updates.push(request.postDataJSON());
        expect(request.postDataJSON()).toEqual(editedFields);
        if (failFirstSave && updates.length === 1) {
          await route.fulfill({
            status: 503,
            json: { error: "Profile editing is temporarily unavailable." },
          });
          return;
        }
        profile = { ...profile, ...editedFields };
      }
      await route.fulfill({ json: { profile } });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: `Unexpected ${request.method()} ${pathname}` },
    });
  });
  return updates;
}
