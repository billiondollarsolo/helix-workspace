import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const initialProfile = {
  actorId: "00000000-0000-4000-8000-000000000111",
  orgId: "00000000-0000-4000-8000-000000000100",
  email: "lea@example.test",
  displayName: "Léa Nguyen",
  pronouns: "she/her",
  jobTitle: "Designer",
  about: "Building the workspace.",
};
const editedFields = {
  displayName: "Nora Singh",
  pronouns: "they/them",
  jobTitle: "Design lead",
  about: "Helping the team work together.",
};

const clearedFields = { ...editedFields, pronouns: "", jobTitle: "", about: "" };

test.beforeEach(() => {
  test.skip(isLiveBackend(), "Profile fault injection uses an isolated mock backend.");
});

test("profile save keeps a failed draft, updates identity, and persists after reopening", async ({
  page,
}) => {
  const requests = await mockProfileBackend(page, true);
  await page.goto("/assistant");
  await expect(
    page.getByRole("heading", { name: "What can I help you with, Léa Nguyen?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings.getByLabel("Display name", { exact: true })).toHaveValue(
    initialProfile.displayName,
  );
  await settings.getByLabel("Display name", { exact: true }).fill(editedFields.displayName);
  await settings.getByLabel("Pronouns", { exact: true }).fill(editedFields.pronouns);
  await settings.getByLabel("Job title", { exact: true }).fill(editedFields.jobTitle);
  await settings.getByLabel("About", { exact: true }).fill(editedFields.about);
  await settings.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveText(
    "Profile storage is temporarily unavailable.",
  );
  await expectProfileFields(page, editedFields);
  expect(requests).toEqual([editedFields]);

  await settings.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(settings.getByRole("status")).toHaveText("Profile saved.");
  expect(requests).toEqual([editedFields, editedFields]);
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What can I help you with, Nora Singh?" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectProfileFields(page, editedFields);
  await expect(page).toHaveURL(/settings=profile/);
  await page.reload();
  await expectProfileFields(page, editedFields);
  await page
    .getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What can I help you with, Nora Singh?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByLabel("Pronouns", { exact: true }).fill("");
  await settings.getByLabel("Job title", { exact: true }).fill("");
  await settings.getByLabel("About", { exact: true }).fill("");
  await expectProfileFields(page, clearedFields);
  await settings.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(settings.getByRole("status")).toHaveText("Profile saved.");
  expect(requests).toEqual([editedFields, editedFields, clearedFields]);
  await page.reload();
  await expectProfileFields(page, clearedFields);
});

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`profile form is accessible at ${viewport.name} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((nextTheme) => {
        localStorage.setItem(
          "helix-appearance",
          JSON.stringify({
            theme: nextTheme,
            density: "compact",
            accent: "#7c3aed",
            fontScale: "default",
          }),
        );
      }, theme);
      await mockProfileBackend(page);
      await page.goto("/assistant?settings=profile");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectProfileFields(page, initialProfile);
      await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeVisible();
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
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    });
  }
}

async function expectProfileFields(page: Page, fields: typeof editedFields) {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings.getByLabel("Display name", { exact: true })).toHaveValue(
    fields.displayName,
  );
  await expect(settings.getByLabel("Pronouns", { exact: true })).toHaveValue(fields.pronouns);
  await expect(settings.getByLabel("Job title", { exact: true })).toHaveValue(fields.jobTitle);
  await expect(settings.getByLabel("About", { exact: true })).toHaveValue(fields.about);
}

async function mockProfileBackend(page: Page, failFirstSave = false): Promise<unknown[]> {
  await seedBrowserSession(page, "profile-editing-session");
  let profile = { ...initialProfile };
  const requests: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "profile-user",
          actorId: profile.actorId,
          email: profile.email,
          name: profile.displayName,
        },
      });
      return;
    }
    if (pathname === "/v1/api/profile") {
      if (request.method() === "PATCH") {
        expect(request.headers()["x-helix-csrf-token"]).toBe("e2e-csrf-token");
        requests.push(request.postDataJSON());
        if (failFirstSave && requests.length === 1) {
          await fulfillJson(
            route,
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "Profile storage is temporarily unavailable.",
              },
            },
            500,
          );
          return;
        }
        const fields = requests.length === 3 ? clearedFields : editedFields;
        expect(request.postDataJSON()).toEqual(fields);
        profile = { ...profile, ...fields };
      }
      await fulfillJson(route, { profile });
      return;
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/v1/api/tools/assistant.conversations.list") {
      await fulfillJson(route, { items: [], nextCursor: null });
      return;
    }
    await fulfillJson(route, {});
  });
  return requests;
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
