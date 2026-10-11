/**
 * Drive feature E2E (P1-1) — drives the real /drive UI in a real browser.
 *
 * MOCKED (default): `/v1/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's drive
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { createRequire } from "node:module";
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const fileId = "00000000-0000-4000-8000-000000000701";
const folderId = "00000000-0000-4000-8000-000000000702";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

test.describe("/drive feature flow", () => {
  test("renders backend Drive items in the virtualized list", async ({ page }) => {
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
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

  test("renames and shares a folder from its details panel", async ({ page }) => {
    test.skip(isLiveBackend(), "Uses deterministic folder fixtures.");
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
    const toolCalls = await mockDriveBackend(page, accessToken);

    await page.goto("/drive");
    await page.getByRole("button", { name: "Details for Planning" }).click();

    const panel = page.getByRole("complementary", { name: "Folder details" });
    await expect(panel).toBeVisible();
    await panel.getByRole("textbox", { name: "Folder name" }).fill("Planning 2027");
    await panel.getByRole("button", { name: "Rename" }).click();
    await expect(panel.getByRole("status")).toHaveText("Renamed.");
    expect(toolCalls).toContainEqual({
      tool: "drive.rename",
      body: { objectId: folderId, name: "Planning 2027" },
    });

    await panel.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share Planning" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Add people" })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Create public link" })).toHaveCount(0);

    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: Element,
              options: object,
            ) => Promise<{ violations: { id: string; impact: string | null }[] }>;
          };
        }
      ).axe;
      const result = await axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      });
      return result.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => violation.id);
    });
    expect(violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});

async function mockDriveBackend(page: Page, accessToken: string) {
  const toolCalls: { tool: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (await fulfillCoreAppsRoute(route)) return;

    if (!(request.headers().cookie ?? "").includes(`helix_session=${accessToken}`)) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing session cookie" }),
      });
      return;
    }

    if (pathname.startsWith("/v1/api/tools/")) {
      toolCalls.push({
        tool: pathname.slice("/v1/api/tools/".length),
        body: request.postDataJSON() as unknown,
      });
    }

    if (pathname === "/v1/api/tools/drive.rename") {
      await fulfillJson(route, {
        id: folderId,
        type: "folder",
        name: "Planning 2027",
        folderId: null,
        ownerActorId: "00000000-0000-4000-8000-000000000111",
        metadata: {},
        deletedAt: null,
        createdAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-21T12:00:00.000Z",
      });
      return;
    }
    if (pathname === "/v1/api/tools/drive.access.list") {
      await fulfillJson(route, { grants: [] });
      return;
    }
    if (pathname === "/v1/api/tools/drive.list") {
      await fulfillJson(route, {
        entries: [
          {
            id: folderId,
            type: "folder",
            name: "Planning",
            folderId: null,
            ownerActorId: "00000000-0000-4000-8000-000000000111",
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          },
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
    if (pathname === "/v1/api/tools/drive.search") {
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
  return toolCalls;
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
