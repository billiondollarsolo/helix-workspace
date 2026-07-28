/**
 * Docs feature E2E (P1-1) — drives the real /docs UI in a real browser.
 *
 * MOCKED (default): `/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's docs
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, mintLiveAccessToken } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const docsScope = "platform.read docs.read";
const docId = "00000000-0000-4000-8000-000000000801";

test.describe("/docs feature flow", () => {
  test("renders backend documents from the Drive-backed list", async ({ page }) => {
    const accessToken = await seedAccessToken(page, docsScope, "e2e-docs-token");
    if (!isLiveBackend()) {
      await mockDocsBackend(page, accessToken);
    }

    await page.goto("/docs");

    await expect(page.getByRole("main", { name: "Docs" })).toBeVisible();

    if (!isLiveBackend()) {
      await expect(page.getByText("Backend listed doc")).toBeVisible();
    } else {
      await expect(page.getByText("Docs backend unavailable")).toHaveCount(0);
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

async function mockDocsBackend(page: Page, accessToken: string) {
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
            id: docId,
            type: "file",
            name: "Backend listed doc.helixdoc",
            folderId: null,
            ownerActorId: "00000000-0000-4000-8000-000000000111",
            app: "docs",
            mimeType: "application/x-helix-document",
            byteSize: 1024,
            sha256: null,
            storageKey: "drive/backend-listed-doc.helixdoc",
            versionNumber: 1,
            metadata: { title: "Backend listed doc" },
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          },
        ],
      });
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
