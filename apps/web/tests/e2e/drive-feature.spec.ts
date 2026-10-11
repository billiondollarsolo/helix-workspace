/**
 * Drive feature E2E (P1-1) — drives the real /drive UI in a real browser.
 *
 * MOCKED (default): `/v1/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's drive
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const ME = "00000000-0000-4000-8000-000000000111";
const SAM = "00000000-0000-4000-8000-000000000222";
const folderId = "00000000-0000-4000-8000-000000000702";
const roadmapId = "00000000-0000-4000-8000-000000000701";
const budgetId = "00000000-0000-4000-8000-000000000703";
const notesId = "00000000-0000-4000-8000-000000000704";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

interface ToolCall {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

function fileEntry(id: string, name: string, mimeType: string, byteSize: number, day: number) {
  return {
    id,
    type: "file",
    name,
    folderId: null,
    ownerActorId: ME,
    ownerDisplayName: "Avery Park",
    mimeType,
    byteSize,
    sha256: null,
    uploadState: "active",
    available: true,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: `2026-05-${String(day).padStart(2, "0")}T12:00:00.000Z`,
  };
}

const ENTRIES = [
  {
    id: folderId,
    type: "folder",
    name: "Planning",
    folderId: null,
    ownerActorId: ME,
    ownerDisplayName: "Avery Park",
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  },
  fileEntry(roadmapId, "Backend roadmap.pdf", "application/pdf", 2048, 21),
  fileEntry(budgetId, "Budget.xlsx", "application/vnd.ms-excel", 9_000, 22),
  fileEntry(notesId, "Notes.txt", "text/plain", 300, 23),
];

test.describe("/drive feature flow", () => {
  test("renders backend Drive items", async ({ page }) => {
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
    if (!isLiveBackend()) {
      await mockDriveBackend(page, accessToken);
    }

    await page.goto("/drive");

    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("My Drive");

    if (!isLiveBackend()) {
      await expect(page.getByText("Backend roadmap.pdf").first()).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    } else {
      // Live mode: no demo sample-data fallback should leak (PRD P0-8).
      await expect(page.getByText("Sample drive file")).toHaveCount(0);
    }
  });

  test("multi-selects with Shift, trashes with Delete and undoes", async ({ page }) => {
    test.skip(isLiveBackend(), "Uses deterministic fixtures.");
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
    const calls = await mockDriveBackend(page, accessToken, { view: "list" });
    await page.goto("/drive");

    const grid = page.getByRole("grid", { name: "Files and folders" });
    await grid.getByRole("row").filter({ hasText: "Backend roadmap.pdf" }).click();
    await grid
      .getByRole("row")
      .filter({ hasText: "Budget.xlsx" })
      .click({ modifiers: ["Shift"] });
    const toolbar = page.getByRole("toolbar", { name: "Selection" });
    await expect(toolbar).toContainText("2 selected");

    await page.keyboard.press("Delete");
    const toast = page.getByText("2 items moved to trash");
    await expect(toast).toBeVisible();
    expect(trashed(calls)).toEqual([roadmapId, budgetId].sort());

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => calls.filter((call) => call.tool === "drive.restore").length).toBe(2);
  });

  test("opens the right-click menu and shares with the people picker", async ({ page }) => {
    test.skip(isLiveBackend(), "Uses deterministic fixtures.");
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
    const calls = await mockDriveBackend(page, accessToken, { view: "list" });
    await page.goto("/drive");

    await page
      .getByRole("row")
      .filter({ hasText: "Backend roadmap.pdf" })
      .click({ button: "right" });
    const menu = page.getByRole("menu");
    for (const item of ["Download", "Share", "Copy link", "Rename", "Move", "Move to trash"]) {
      await expect(menu.getByRole("menuitem", { name: item, exact: false }).first()).toBeVisible();
    }
    await menu.getByRole("menuitem", { name: /^Share/u }).click();

    const dialog = page.getByRole("dialog", { name: "Share “Backend roadmap.pdf”" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Add people" }).fill("sam");
    await dialog.getByRole("option", { name: /Sam Patel/u }).click();
    await dialog.getByRole("combobox", { name: "Role for new people" }).selectOption("editor");
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
    await expect
      .poll(() => calls.find((call) => call.tool === "drive.share")?.body)
      .toMatchObject({ objectId: roadmapId, actorIds: [SAM], role: "editor" });

    await expect(dialog.getByRole("combobox", { name: "General access" })).toHaveValue(
      "restricted",
    );
    await dialog.getByRole("combobox", { name: "General access" }).selectOption("anyone");
    await expect
      .poll(() => calls.find((call) => call.tool === "drive.link.create")?.body)
      .toMatchObject({ objectId: roadmapId, allowedDomains: [] });
    expect(await seriousViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("uploads a folder and keeps its structure", async ({ page }) => {
    test.skip(isLiveBackend(), "Uses deterministic fixtures.");
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
    const calls = await mockDriveBackend(page, accessToken);
    await page.goto("/drive");
    await expect(page.getByText("Backend roadmap.pdf").first()).toBeVisible();

    const root = mkdtempSync(path.join(tmpdir(), "helix-drive-upload-"));
    mkdirSync(path.join(root, "Trip", "Day 1"), { recursive: true });
    writeFileSync(path.join(root, "Trip", "itinerary.txt"), "plan");
    writeFileSync(path.join(root, "Trip", "Day 1", "photo.png"), "png");
    await page.getByTestId("drive-folder-input").setInputFiles(path.join(root, "Trip"));

    const panel = page.getByRole("region", { name: "Uploads" });
    await expect(panel).toContainText("2 uploads complete");
    const folders = calls.filter((call) => call.tool === "drive.create").map((call) => call.body);
    expect(folders).toEqual([
      { kind: "folder", name: "Trip", folderId: null },
      { kind: "folder", name: "Day 1", folderId: "00000000-0000-4000-8000-00000000c001" },
    ]);
    const uploads = calls.filter((call) => call.tool === "drive.upload").map((call) => call.body);
    expect(uploads.map((body) => [body.name, body.folderId]).sort()).toEqual([
      ["itinerary.txt", "00000000-0000-4000-8000-00000000c001"],
      ["photo.png", "00000000-0000-4000-8000-00000000c002"],
    ]);
  });

  test("switches between grid and list and sorts by file size", async ({ page }) => {
    test.skip(isLiveBackend(), "Uses deterministic fixtures.");
    const accessToken = await seedBrowserSession(page, "e2e-drive-token");
    const calls = await mockDriveBackend(page, accessToken, { view: "grid" });
    await page.goto("/drive");

    await expect(page.getByRole("grid", { name: "Files" })).toBeVisible();
    await page.getByRole("button", { name: "List layout" }).click();
    await expect(page.getByRole("grid", { name: "Files and folders" })).toBeVisible();
    expect(calls.find((call) => call.tool === "drive.view.set")?.body).toEqual({ view: "list" });

    await page.getByRole("button", { name: /^Sort by Name/u }).click();
    await page.getByRole("menuitemradio", { name: "File size" }).click();
    const names = page.locator('[role="row"][data-key] .drive-col-name [title]');
    await expect(names).toHaveText(["Planning", "Budget.xlsx", "Backend roadmap.pdf", "Notes.txt"]);
  });
});

function trashed(calls: readonly ToolCall[]): string[] {
  return calls
    .filter((call) => call.tool === "drive.trash")
    .map((call) => String(call.body.objectId))
    .sort();
}

async function seriousViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
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
}

async function mockDriveBackend(
  page: Page,
  accessToken: string,
  options: { readonly view?: "grid" | "list" } = {},
) {
  const toolCalls: ToolCall[] = [];
  let createdFolders = 0;
  let uploads = 0;
  await page.route("https://storage.e2e.test/**", (route) => route.fulfill({ status: 200 }));
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

    if (pathname === "/v1/api/people/autocomplete") {
      await fulfillJson(route, {
        people: [
          {
            id: SAM,
            email: "sam@example.test",
            displayName: "Sam Patel",
            kind: "directory",
            actorId: SAM,
            title: null,
            favorite: false,
            avatarDataUrl: null,
            relationship: {},
          },
        ],
      });
      return;
    }

    if (!pathname.startsWith("/v1/api/tools/")) {
      await fulfillJson(route, {});
      return;
    }
    const tool = pathname.slice("/v1/api/tools/".length);
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    toolCalls.push({ tool, body });

    switch (tool) {
      case "drive.list":
        await fulfillJson(route, { entries: ENTRIES, nextCursor: null });
        return;
      case "drive.view.get":
        await fulfillJson(route, { view: options.view ?? "grid" });
        return;
      case "drive.view.set":
        await fulfillJson(route, { view: body.view });
        return;
      case "drive.storage.usage":
        await fulfillJson(route, {
          usedBytes: 11_348,
          limitBytes: null,
          organizationUsedBytes: null,
        });
        return;
      case "drive.trash":
      case "drive.restore":
        await fulfillJson(route, ENTRIES.find((entry) => entry.id === body.objectId) ?? null);
        return;
      case "drive.access.list":
        await fulfillJson(route, { grants: [] });
        return;
      case "drive.link.list":
        await fulfillJson(route, { links: [] });
        return;
      case "drive.share":
        await fulfillJson(route, {
          objectId: body.objectId,
          sharedWithActorIds: [SAM],
          role: body.role,
        });
        return;
      case "drive.link.create":
        await fulfillJson(route, {
          id: "00000000-0000-4000-8000-0000000000e1",
          orgId: ME,
          objectId: body.objectId,
          token: "t".repeat(43),
          role: "reader",
          expiresAt: null,
          passwordProtected: false,
          oneTime: false,
          allowedDomains: body.allowedDomains,
          allowDownload: true,
          consumedAt: null,
          createdByActorId: ME,
          createdAt: "2026-05-20T12:00:00.000Z",
          revokedAt: null,
          maxDownloads: null,
          downloadCount: 0,
          rateLimitPerHour: 120,
          lastUsedAt: null,
        });
        return;
      case "drive.create":
        createdFolders += 1;
        await fulfillJson(route, {
          id: `00000000-0000-4000-8000-00000000c00${String(createdFolders)}`,
        });
        return;
      case "drive.upload":
        uploads += 1;
        await fulfillJson(route, {
          objectId: `00000000-0000-4000-8000-00000000f00${String(uploads)}`,
          orgId: ME,
          ownerActorId: ME,
          name: body.name,
          folderId: body.folderId,
          storageKey: `drive/${String(body.name)}`,
          mimeType: body.mimeType,
          byteSize: body.byteSize,
          sha256: null,
          status: "pending_upload",
          uploadUrl: `https://storage.e2e.test/${String(uploads)}`,
          uploadHeaders: {},
          metadata: {},
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        });
        return;
      case "drive.upload.status":
        await fulfillJson(route, {
          objectId: body.objectId,
          state: "active",
          label: "Available",
          available: true,
          terminal: true,
          updatedAt: "2026-05-20T12:00:00.000Z",
        });
        return;
      default:
        await fulfillJson(route, {});
    }
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
