/**
 * Drive feature E2E (P1-1) — drives the real /drive UI in a real browser.
 *
 * MOCKED (default): `/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's drive
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, mintLiveAccessToken } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const driveScope = "platform.read drive.read";
const fileId = "00000000-0000-4000-8000-000000000701";

test.describe("/drive feature flow", () => {
  test("renders backend Drive items in the virtualized list", async ({ page }) => {
    const accessToken = await seedAccessToken(page, driveScope, "e2e-drive-token");
    if (!isLiveBackend()) {
      await mockDriveBackend(page, accessToken);
    }

    await page.goto("/drive");

    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    if (!isLiveBackend()) {
      await expect(page.getByText("Backend roadmap.pdf").first()).toBeVisible();
    } else {
      // Live mode: no demo sample-data fallback should leak (PRD P0-8).
      await expect(page.getByText("Sample drive file")).toHaveCount(0);
    }
  });
});

async function seedAccessToken(page: Page, scope: string, mockToken: string): Promise<string> {
  const token = isLiveBackend() ? await mintLiveAccessToken(scope) : mockToken;
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: accessTokenStorageKey, value: token },
  );
  return token;
}

async function mockDriveBackend(page: Page, accessToken: string) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (request.headers().authorization !== `Bearer ${accessToken}`) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing bearer token" }),
      });
      return;
    }

    if (pathname === "/api/tools/drive.list") {
      await fulfillJson(route, {
        entries: [
          {
            id: fileId,
            type: "file",
            name: "Backend roadmap.pdf",
            folderId: null,
            ownerActorId: "00000000-0000-4000-8000-000000000111",
            mimeType: "application/pdf",
            byteSize: 2048,
            sha256: null,
            storageKey: "drive/backend-roadmap.pdf",
            versionNumber: 1,
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (pathname === "/api/tools/drive.search") {
      await fulfillJson(route, { entries: [] });
      return;
    }

    // The production shell calls GET /api/core-apps on mount; serve the
    // shared valid CoreAppShellStatus fixture so the shell never crashes.
    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    await fulfillJson(route, {});
  });
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
