import { Buffer } from "node:buffer";
import { expect, test, type Page, type Route } from "@playwright/test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const viewStorageKey = "helix.documentSurface.view";

const rawDocxId = "00000000-0000-4000-8000-000000000901";
const rawXlsxId = "00000000-0000-4000-8000-000000000902";
const rawPptxId = "00000000-0000-4000-8000-000000000903";

const rawDocxName = "Workspace route smoke.docx";
const rawXlsxName = "Workspace route smoke.xlsx";
const rawPptxName = "Workspace route smoke.pptx";

test.describe("app-list raw Office open routes", () => {
  test("Docs opens raw DOCX through the universal copy/preview flow", async ({ page }) => {
    const nativeCalls: string[] = [];
    await seedListView(page);
    await mockOfficeRouteBackend(page, nativeCalls);

    await page.goto("/docs");
    await page.getByText(rawDocxName, { exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/docs/${rawDocxId}\\?open=office$`));
    await expect(page.getByRole("heading", { name: "Create editable copy?" })).toBeVisible();
    await expect(page.getByText(rawDocxName, { exact: true })).toBeVisible();
    expect(nativeCalls).toEqual([]);
  });

  test("Sheets opens raw XLSX through the universal copy/preview flow", async ({ page }) => {
    const nativeCalls: string[] = [];
    await seedListView(page);
    await mockOfficeRouteBackend(page, nativeCalls);

    await page.goto("/sheets");
    await page.getByText(rawXlsxName, { exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/sheets\\?sheet=${rawXlsxId}&open=office$`));
    await expect(page.getByRole("heading", { name: "Create editable copy?" })).toBeVisible();
    await expect(page.getByText(rawXlsxName, { exact: true })).toBeVisible();
    expect(nativeCalls).toEqual([]);
  });

  test("Slides opens raw PPTX through the universal copy/preview flow", async ({ page }) => {
    const nativeCalls: string[] = [];
    await seedListView(page);
    await mockOfficeRouteBackend(page, nativeCalls);

    await page.goto("/slides");
    await page.getByText(rawPptxName, { exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/slides\\?deck=${rawPptxId}&open=office$`));
    await expect(page.getByRole("heading", { name: "Create editable copy?" })).toBeVisible();
    await expect(page.getByText(rawPptxName, { exact: true })).toBeVisible();
    expect(nativeCalls).toEqual([]);
  });
});

async function seedListView(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenKey, viewKey }) => {
      window.localStorage.setItem(tokenKey, "e2e-office-route-token");
      window.localStorage.setItem(viewKey, "list");
    },
    { tokenKey: accessTokenStorageKey, viewKey: viewStorageKey },
  );
}

async function mockOfficeRouteBackend(page: Page, nativeCalls: string[]): Promise<void> {
  const content = await officeFixtureContent();

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

    if (
      url.pathname.startsWith("/api/editors/documents/") ||
      url.pathname === "/api/tools/sheets.get" ||
      url.pathname === "/api/tools/slides.deck.get"
    ) {
      nativeCalls.push(url.pathname);
      await fulfillJson(route, { error: "raw Office rows must not hit native editor fetches" }, 500);
      return;
    }

    if (url.pathname === "/api/tools/drive.list") {
      const body = route.request().postDataJSON() as { readonly app?: string };
      await fulfillJson(route, { entries: entriesForApp(body.app) });
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

async function officeFixtureContent(): Promise<
  Map<string, { readonly name: string; readonly mimeType: string; readonly bytes: Buffer }>
> {
  const [docx, pptx] = await Promise.all([minimalDocx(), minimalPptx()]);
  return new Map([
    [
      rawDocxId,
      {
        name: rawDocxName,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: docx,
      },
    ],
    [
      rawXlsxId,
      {
        name: rawXlsxName,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: minimalXlsx(),
      },
    ],
    [
      rawPptxId,
      {
        name: rawPptxName,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: pptx,
      },
    ],
  ]);
}

function entriesForApp(app: string | undefined) {
  if (app === "docs") {
    return [driveEntry(rawDocxId, rawDocxName, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")];
  }
  if (app === "sheets") {
    return [driveEntry(rawXlsxId, rawXlsxName, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")];
  }
  if (app === "slides") {
    return [driveEntry(rawPptxId, rawPptxName, "application/vnd.openxmlformats-officedocument.presentationml.presentation")];
  }
  return [];
}

function driveEntry(id: string, name: string, mimeType: string) {
  return {
    id,
    type: "file",
    name,
    folderId: null,
    ownerActorId: "00000000-0000-4000-8000-000000000111",
    app: null,
    mimeType,
    byteSize: 4096,
    sha256: null,
    storageKey: `drive/e2e/${name}`,
    versionNumber: 1,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-28T12:00:00.000Z",
    updatedAt: "2026-05-28T12:00:00.000Z",
  };
}

async function minimalDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.folder("word")?.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Route smoke document</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function minimalXlsx(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Customer", "ARR"],
      ["Acme", 1200],
    ]),
    "Pipeline",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function minimalPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Route smoke deck</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>First bullet</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
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
