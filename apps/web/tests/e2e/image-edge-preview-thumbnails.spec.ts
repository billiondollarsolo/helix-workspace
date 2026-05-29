import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const viewStorageKey = "helix.documentSurface.view";
const ownerActorId = "00000000-0000-4000-8000-000000000111";

test.describe("edge image preview thumbnails", () => {
  test("renders generic-MIME JPEG 2000 and JPEG XL files through safe preview images", async ({
    page,
  }) => {
    const previewRequests: string[] = [];
    await seedGridSession(page);
    await mockDriveBackend(page, previewRequests);

    await page.goto("/drive");

    for (const entry of edgeImageEntries) {
      const preview = page.getByLabel(`Preview of ${entry.name}`, { exact: true });
      await expect(preview).toBeVisible();
      const image = preview.locator("img");
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute("src", `/api/drive/objects/${entry.id}/preview`);
      await expect
        .poll(() =>
          image.evaluate((node) =>
            node instanceof HTMLImageElement ? node.naturalWidth : 0,
          ),
        )
        .toBeGreaterThan(0);
    }

    expect(previewRequests).toEqual(
      expect.arrayContaining(edgeImageEntries.map((entry) => expect.stringContaining(entry.id))),
    );
  });
});

async function seedGridSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenKey, viewKey }) => {
      window.localStorage.setItem(tokenKey, "e2e-edge-image-token");
      window.localStorage.setItem(viewKey, "grid");
    },
    { tokenKey: accessTokenStorageKey, viewKey: viewStorageKey },
  );
}

async function mockDriveBackend(page: Page, previewRequests: string[]): Promise<void> {
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
      await fulfillJson(route, { entries: edgeImageEntries });
      return;
    }

    if (url.pathname === "/api/tools/drive.search") {
      await fulfillJson(route, { hits: [] });
      return;
    }

    if (url.pathname.startsWith("/api/drive/objects/") && url.pathname.endsWith("/preview")) {
      previewRequests.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: transparentPng,
      });
      return;
    }

    await fulfillJson(route, {});
  });
}

const edgeImageEntries = [
  driveFile({
    id: "00000000-0000-4000-8000-000000001301",
    name: "Generic JPEG 2000 scan.jp2",
  }),
  driveFile({
    id: "00000000-0000-4000-8000-000000001302",
    name: "Generic JPEG XL photo.jxl",
  }),
];

function driveFile(input: { readonly id: string; readonly name: string }) {
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: null,
    ownerActorId,
    app: null,
    mimeType: "application/octet-stream",
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

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
