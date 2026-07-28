import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const viewStorageKey = "helix.documentSurface.view";
const ownerActorId = "00000000-0000-4000-8000-000000000111";

const spreadsheetFixtures = [
  {
    id: "00000000-0000-4000-8000-000000000921",
    name: "Tika binary workbook.xlsb",
    mimeType: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    corpusPath: "../../../../test-corpus/apache-tika/microsoft/testEXCEL.xlsb",
  },
  {
    id: "00000000-0000-4000-8000-000000000922",
    name: "Tika macro workbook.xlsm",
    mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    corpusPath: "../../../../test-corpus/apache-tika/microsoft/testEXCEL_macro.xlsm",
  },
  {
    id: "00000000-0000-4000-8000-000000000923",
    name: "Tika template workbook.xltx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    corpusPath: "../../../../test-corpus/apache-tika/microsoft/testEXCEL_template.xltx",
  },
] as const;

test.describe("Excel-family workbook import routes", () => {
  test.skip(
    spreadsheetFixtures.some((fixture) => !existsSync(new URL(fixture.corpusPath, import.meta.url))),
    "Apache Tika workbook corpus is not available in this checkout",
  );

  for (const fixture of spreadsheetFixtures) {
    test(`opens ${fixture.name} through the editable-copy flow`, async ({ page }) => {
      const importCalls: ImportCall[] = [];
      await seedListView(page);
      await mockWorkbookBackend(page, importCalls);

      await page.goto("/sheets");
      await expect(page.getByRole("heading", { name: "Spreadsheets" })).toBeVisible();
      await page.getByText(fixture.name, { exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`/sheets\\?sheet=${fixture.id}&open=office$`));
      await expect(page.getByRole("heading", { name: "Create editable copy?" })).toBeVisible();
      await expect(page.getByText(fixture.name, { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Create copy" }).click();

      await expect.poll(() => importCalls).toHaveLength(1);
      expect(importCalls[0]).toMatchObject({
        filename: fixture.name,
        title: fixture.name.replace(/\.[^.]+$/u, ""),
      });
      expect(importCalls[0]?.contentBase64.length).toBeGreaterThan(100);
      await expect(page).toHaveURL(new RegExp("/sheets\\?sheet=native-"));
    });
  }
});

interface ImportCall {
  readonly filename: string;
  readonly title?: string;
  readonly contentBase64: string;
  readonly metadata?: Record<string, unknown>;
}

async function seedListView(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenKey, viewKey }) => {
      window.localStorage.setItem(tokenKey, "e2e-excel-family-token");
      window.localStorage.setItem(viewKey, "list");
    },
    { tokenKey: accessTokenStorageKey, viewKey: viewStorageKey },
  );
}

async function mockWorkbookBackend(page: Page, importCalls: ImportCall[]): Promise<void> {
  const content = fixtureContent();

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
      await fulfillJson(route, { entries: spreadsheetFixtures.map(driveEntry) });
      return;
    }

    if (url.pathname === "/api/tools/sheets.import-xlsx") {
      const body = request.postDataJSON() as ImportCall;
      importCalls.push(body);
      await fulfillJson(route, importedSheet(body));
      return;
    }

    if (url.pathname === "/api/tools/sheets.get") {
      await fulfillJson(route, importedSheet({ filename: "Imported.xlsx", contentBase64: "" }));
      return;
    }

    if (url.pathname === "/api/tools/sheets.tab.get") {
      await fulfillJson(route, {
        ...sheetTab(),
        cells: [],
      });
      return;
    }

    const objectId = objectIdFromContentPath(url.pathname);
    const item = objectId === null ? undefined : content.get(objectId);
    if (item !== undefined) {
      await route.fulfill({
        status: 200,
        contentType: item.mimeType,
        headers: {
          "content-disposition": `inline; filename="${item.name}"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        },
        body: item.bytes,
      });
      return;
    }

    await fulfillJson(route, {});
  });
}

function fixtureContent(): Map<
  string,
  { readonly name: string; readonly mimeType: string; readonly bytes: Buffer }
> {
  return new Map(
    spreadsheetFixtures.map((fixture) => [
      fixture.id,
      {
        name: fixture.name,
        mimeType: fixture.mimeType,
        bytes: readFileSync(new URL(fixture.corpusPath, import.meta.url)),
      },
    ]),
  );
}

function driveEntry(fixture: (typeof spreadsheetFixtures)[number]) {
  return {
    id: fixture.id,
    type: "file",
    name: fixture.name,
    folderId: null,
    ownerActorId,
    app: null,
    mimeType: fixture.mimeType,
    byteSize: 4096,
    sha256: null,
    storageKey: `drive/e2e/${fixture.name}`,
    versionNumber: 1,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-28T12:00:00.000Z",
    updatedAt: "2026-05-28T12:00:00.000Z",
  };
}

function importedSheet(call: Pick<ImportCall, "filename"> & Partial<Pick<ImportCall, "contentBase64">>) {
  const sheetId = `native-${call.filename.replace(/[^a-z0-9]/giu, "-").toLowerCase()}`;
  return {
    id: sheetId,
    ownerActorId,
    createdByActorId: ownerActorId,
    title: call.filename.replace(/\.[^.]+$/u, ""),
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-28T12:00:00.000Z",
    updatedAt: "2026-05-28T12:00:00.000Z",
    tabs: [sheetTab(sheetId)],
    import: {
      format: "xlsx",
      filename: call.filename,
      sheetCount: 1,
      rowCount: 1,
      columnCount: 1,
      populatedCellCount: 1,
    },
  };
}

function sheetTab(sheetId = "native-imported") {
  return {
    id: `${sheetId}-tab-1`,
    sheetId,
    name: "Sheet1",
    position: 0,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-28T12:00:00.000Z",
    updatedAt: "2026-05-28T12:00:00.000Z",
  };
}

function objectIdFromContentPath(pathname: string): string | null {
  const match = /^\/api\/drive\/objects\/([^/]+)\/content$/u.exec(pathname);
  return match?.[1] ?? null;
}

async function fulfillJson(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
