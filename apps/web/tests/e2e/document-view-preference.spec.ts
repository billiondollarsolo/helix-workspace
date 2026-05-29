import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const viewStorageKey = "helix.documentSurface.view";
const ownerActorId = "00000000-0000-4000-8000-000000000111";

test.describe("document surface view preference", () => {
  test("persists card/list mode across Drive, Docs, Sheets, and Slides", async ({ page }) => {
    await seedSession(page);
    await mockDocumentSurfaceBackend(page);

    await page.goto("/drive");
    await expect(page.getByRole("button", { name: "Card view" })).toBeVisible();
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto("/sheets");
    await expect(page.getByRole("heading", { name: "Spreadsheets" })).toBeVisible();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Card view" }).click();
    await expect(page.getByRole("button", { name: "Card view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto("/docs");
    await expect(page.getByRole("button", { name: "Card view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Card view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto("/slides");
    await expect(page.getByRole("button", { name: "Card view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Card view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto("/drive");
    await expect(page.getByRole("button", { name: "Card view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Card view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), viewStorageKey))
      .toBe("grid");
  });
});

async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenKey }) => {
      window.localStorage.setItem(tokenKey, "e2e-view-preference-token");
    },
    { tokenKey: accessTokenStorageKey },
  );
}

async function mockDocumentSurfaceBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "e2e-user",
          email: "e2e@helix.local",
          name: "E2E User",
          actorId: ownerActorId,
        },
      });
      return;
    }

    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    if (url.pathname === "/api/tools/drive.list") {
      const body = request.postDataJSON() as { readonly app?: string };
      await fulfillJson(route, { entries: entriesForApp(body.app) });
      return;
    }

    if (url.pathname === "/api/tools/drive.search") {
      await fulfillJson(route, { hits: [] });
      return;
    }

    await fulfillJson(route, {});
  });
}

function entriesForApp(app: string | undefined) {
  if (app === "docs") {
    return [
      driveEntry({
        id: "00000000-0000-4000-8000-000000000911",
        name: "Preference document.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ];
  }
  if (app === "sheets") {
    return [
      driveEntry({
        id: "00000000-0000-4000-8000-000000000912",
        name: "Preference workbook.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ];
  }
  if (app === "slides") {
    return [
      driveEntry({
        id: "00000000-0000-4000-8000-000000000913",
        name: "Preference deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ];
  }
  return [
    driveEntry({
      id: "00000000-0000-4000-8000-000000000914",
      name: "Preference PDF.pdf",
      mimeType: "application/pdf",
    }),
  ];
}

function driveEntry(input: { readonly id: string; readonly name: string; readonly mimeType: string }) {
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: null,
    ownerActorId,
    app: null,
    mimeType: input.mimeType,
    byteSize: 4096,
    sha256: null,
    storageKey: `drive/e2e/${input.name}`,
    versionNumber: 1,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-28T12:00:00.000Z",
    updatedAt: "2026-05-28T12:00:00.000Z",
  };
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
