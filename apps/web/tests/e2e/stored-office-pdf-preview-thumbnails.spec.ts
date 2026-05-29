import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const viewStorageKey = "helix.documentSurface.view";
const ownerActorId = "00000000-0000-4000-8000-000000000111";

test.describe("stored Office PDF preview thumbnails", () => {
  test("render as real first-page thumbnails across Drive and app surfaces", async ({ page }) => {
    const previewRequests: string[] = [];
    await seedGridSession(page);
    await mockPreviewBackend(page, previewRequests);

    for (const surface of ["/drive", "/docs", "/sheets", "/slides"]) {
      await page.goto(surface);
      const entry = entryForSurface(surface);
      await expect(page.getByLabel(`Preview of ${entry.name}`, { exact: true })).toBeVisible();
      const rendered = page.getByLabel(`Rendered first page of ${entry.name}`, { exact: true });
      await expect(rendered).toBeVisible({ timeout: 10_000 });
      await expect(rendered).toHaveAttribute("src", /^data:image\/png;base64,/u);
    }

    expect(previewRequests).toEqual(
      expect.arrayContaining([
        expect.stringContaining(driveEntry.id),
        expect.stringContaining(docsEntry.id),
        expect.stringContaining(sheetsEntry.id),
        expect.stringContaining(slidesEntry.id),
      ]),
    );
  });
});

async function seedGridSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokenKey, viewKey }) => {
      window.localStorage.setItem(tokenKey, "e2e-stored-preview-token");
      window.localStorage.setItem(viewKey, "grid");
    },
    { tokenKey: accessTokenStorageKey, viewKey: viewStorageKey },
  );
}

async function mockPreviewBackend(page: Page, previewRequests: string[]): Promise<void> {
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

    if (url.pathname.startsWith("/api/drive/objects/") && url.pathname.endsWith("/preview")) {
      previewRequests.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: minimalPdfBytes("Stored Office preview"),
      });
      return;
    }

    await fulfillJson(route, {});
  });
}

function entriesForApp(app: string | undefined) {
  if (app === "docs") {
    return [docsEntry];
  }
  if (app === "sheets") {
    return [sheetsEntry];
  }
  if (app === "slides") {
    return [slidesEntry];
  }
  return [driveEntry];
}

function entryForSurface(surface: string) {
  if (surface === "/docs") {
    return docsEntry;
  }
  if (surface === "/sheets") {
    return sheetsEntry;
  }
  if (surface === "/slides") {
    return slidesEntry;
  }
  return driveEntry;
}

const driveEntry = driveFile({
  id: "00000000-0000-4000-8000-000000001201",
  name: "Drive uploaded workbook.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

const docsEntry = driveFile({
  id: "00000000-0000-4000-8000-000000001202",
  name: "Stored preview document.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

const sheetsEntry = driveFile({
  id: "00000000-0000-4000-8000-000000001203",
  name: "Stored preview workbook.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

const slidesEntry = driveFile({
  id: "00000000-0000-4000-8000-000000001204",
  name: "Stored preview deck.pptx",
  mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

function driveFile(input: { readonly id: string; readonly name: string; readonly mimeType: string }) {
  const preview = {
    kind: "pdf",
    status: "available",
    mimeType: "application/pdf",
    storageKey: `drive-previews/e2e/${input.id}/v1/preview.pdf`,
    generatedAt: "2026-05-28T12:00:00.000Z",
  };
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: null,
    ownerActorId,
    app: null,
    mimeType: input.mimeType,
    byteSize: 8192,
    sha256: null,
    storageKey: `drive/e2e/${input.name}`,
    versionNumber: 1,
    preview,
    metadata: { preview },
    deletedAt: null,
    createdAt: "2026-05-28T12:00:00.000Z",
    updatedAt: "2026-05-28T12:00:00.000Z",
  };
}

function minimalPdfBytes(text: string): Buffer {
  const escaped = text.replace(/[\\()]/gu, "\\$&");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(escaped.length + 45)} >>\nstream\nBT /F1 18 Tf 36 92 Td (${escaped}) Tj ET\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
