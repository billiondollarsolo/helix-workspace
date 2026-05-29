import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const viewStorageKey = "helix.documentSurface.view";
const workbookCount = 80;
const workbookMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test.describe("/sheets thumbnail previews", () => {
  test("loads generated previews near the viewport and defers offscreen cards", async ({
    page,
  }) => {
    const previewRequests: string[] = [];
    await seedGridView(page);
    await mockSheetsPreviewBackend(page, previewRequests);

    await page.goto("/sheets");

    await expect(page.getByRole("heading", { name: "Spreadsheets" })).toBeVisible();
    await expect(page.getByLabel("Preview of Lazy workbook 001.xlsx", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("Rendered preview of Lazy workbook 001.xlsx", { exact: true }),
    ).toBeVisible();

    const initialRequestCount = previewRequests.length;
    expect(initialRequestCount).toBeGreaterThan(0);
    expect(initialRequestCount).toBeLessThan(workbookCount);
    expect(previewRequests.some((url) => url.includes(workbookId(1)))).toBe(true);
    expect(previewRequests.some((url) => url.includes(workbookId(workbookCount)))).toBe(false);

    await scrollSheetsContentToEnd(page);

    await expect
      .poll(() => previewRequests.length, { timeout: 5_000 })
      .toBeGreaterThan(initialRequestCount);
    await expect
      .poll(
        () => previewRequests.some((url) => url.includes(workbookId(workbookCount))),
        { timeout: 5_000 },
      )
      .toBe(true);
  });
});

async function seedGridView(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenKey, viewKey }) => {
      window.localStorage.setItem(tokenKey, "e2e-thumbnail-token");
      window.localStorage.setItem(viewKey, "grid");
    },
    { tokenKey: accessTokenStorageKey, viewKey: viewStorageKey },
  );
}

async function mockSheetsPreviewBackend(
  page: Page,
  previewRequests: string[],
): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "e2e-user",
          email: "e2e@helix.local",
          name: "E2E User",
          actorId: "00000000-0000-4000-8000-000000000111",
        },
      });
      return;
    }

    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    if (url.pathname === "/api/tools/drive.list") {
      await fulfillJson(route, { entries: workbookEntries() });
      return;
    }

    if (url.pathname.startsWith("/api/drive/objects/") && url.pathname.endsWith("/preview")) {
      previewRequests.push(request.url());
      const objectId = url.pathname.split("/").at(-2) ?? "";
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: spreadsheetPreviewHtml(objectId),
      });
      return;
    }

    await fulfillJson(route, {});
  });
}

function workbookEntries() {
  return Array.from({ length: workbookCount }, (_, index) => {
    const number = index + 1;
    return {
      id: workbookId(number),
      type: "file",
      name: `Lazy workbook ${String(number).padStart(3, "0")}.xlsx`,
      folderId: null,
      ownerActorId: "00000000-0000-4000-8000-000000000111",
      app: null,
      mimeType: workbookMimeType,
      byteSize: 24_576 + number,
      sha256: null,
      storageKey: `drive/lazy-workbook-${String(number).padStart(3, "0")}.xlsx`,
      versionNumber: 1,
      metadata: {
        preview: {
          kind: "office",
          status: "unsupported",
          mimeType: workbookMimeType,
        },
      },
      deletedAt: null,
      createdAt: "2026-05-28T12:00:00.000Z",
      updatedAt: "2026-05-28T12:00:00.000Z",
    };
  });
}

function workbookId(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function spreadsheetPreviewHtml(objectId: string): string {
  return `<!doctype html>
    <html>
      <body>
        <table>
          <tbody>
            <tr><td>Preview</td><td>${objectId}</td></tr>
            <tr><td>ARR</td><td>${String(Number(objectId.slice(-3)))}</td></tr>
          </tbody>
        </table>
      </body>
    </html>`;
}

async function scrollSheetsContentToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = Array.from(document.querySelectorAll<HTMLElement>("div")).find((element) => {
      const style = window.getComputedStyle(element);
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        element.scrollHeight > element.clientHeight
      );
    });
    if (scroller === undefined) {
      throw new Error("Could not find a scrollable sheets content pane.");
    }
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
