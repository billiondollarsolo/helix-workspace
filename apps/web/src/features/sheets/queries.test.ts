import { afterEach, describe, expect, it, vi } from "vitest";
import { sheetsListFromDriveQueryOptions } from "./queries";
import type { SheetListRow } from "./model";
import { filterSheetsByFolder } from "./sheets-list";

describe("sheetsListFromDriveQueryOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads spreadsheet-shaped files across Drive folders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            entries: [
              driveEntry({
                id: "11111111-1111-4111-8111-111111111111",
                app: "sheets",
                name: "Native forecast.sheet",
              }),
              driveEntry({
                id: "22222222-2222-4222-8222-222222222222",
                app: "sheets",
                name: "Uploaded workbook.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                metadata: { title: "Uploaded workbook", starred: true, sharedCount: 4 },
                preview: {
                  kind: "pdf",
                  status: "available",
                  mimeType: "application/pdf",
                  url: "https://cdn.example/uploaded-workbook.pdf",
                },
              }),
              driveEntry({
                id: "33333333-3333-4333-8333-333333333333",
                app: null,
                name: "Legacy budget.xls",
                mimeType: "application/vnd.ms-excel",
                metadata: {
                  preview: {
                    kind: "office",
                    status: "unsupported",
                    mimeType: "application/vnd.ms-excel",
                    blocker: "Office preview conversion requires the LibreOffice preview service.",
                  },
                },
              }),
              driveEntry({
                id: "44444444-4444-4444-8444-444444444444",
                app: null,
                name: "Macro model.xlsm",
                mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
              }),
              driveEntry({
                id: "55555555-5555-4555-8555-555555555555",
                app: null,
                name: "Binary workbook.xlsb",
                mimeType: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
              }),
              driveEntry({
                id: "66666666-6666-4666-8666-666666666666",
                app: null,
                name: "Template.xltx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
              }),
              driveEntry({
                id: "77777777-7777-4777-8777-777777777777",
                app: null,
                name: "Open forecast.ods",
                mimeType: "application/vnd.oasis.opendocument.spreadsheet",
              }),
              driveEntry({
                id: "88888888-8888-4888-8888-888888888888",
                app: null,
                name: "Import data.csv",
                mimeType: "text/csv",
              }),
              driveEntry({
                id: "99999999-9999-4999-8999-999999999999",
                app: null,
                name: "Import data.tsv",
                mimeType: "text/tab-separated-values",
              }),
              driveEntry({
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                app: null,
                name: "Deleted budget.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                deletedAt: "2026-05-22T12:00:00.000Z",
              }),
              driveEntry({
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                app: null,
                name: "Notes.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              }),
            ],
          }),
        ),
      ),
    );

    const options = sheetsListFromDriveQueryOptions({ limit: 10 });
    const rows = await (options.queryFn as () => Promise<readonly SheetListRow[]>)();

    expect(rows.map((row) => [row.title, row.openMode])).toEqual([
      ["Native forecast", "native"],
      ["Uploaded workbook.xlsx", "office"],
      ["Legacy budget.xls", "office"],
      ["Macro model.xlsm", "office"],
      ["Binary workbook.xlsb", "office"],
      ["Template.xltx", "office"],
      ["Open forecast.ods", "office"],
      ["Import data.csv", "office"],
      ["Import data.tsv", "office"],
      ["Deleted budget.xlsx", "office"],
    ]);
    expect(rows.map((row) => row.formatLabel)).toEqual([
      "SHEET",
      "XLSX",
      "XLS",
      "XLSM",
      "XLSB",
      "XLTX",
      "ODS",
      "CSV",
      "TSV",
      "XLSX",
    ]);
    expect(rows[1]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(rows[1]?.preview?.url).toBe("https://cdn.example/uploaded-workbook.pdf");
    expect(rows[1]?.starred).toBe(true);
    expect(rows[1]?.shared).toBe(4);
    expect(rows.at(-1)?.deletedAt).toBe("2026-05-22T12:00:00.000Z");
    expect(rows[2]?.preview).toMatchObject({
      kind: "office",
      status: "unsupported",
      mimeType: "application/vnd.ms-excel",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.list", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        folderId: null,
        includeTrashed: true,
        limit: 10,
        app: "sheets",
        acrossFolders: true,
      }),
    });
  });

  it("filters live, shared, starred, and trashed spreadsheets from Drive metadata", () => {
    const rows: readonly SheetListRow[] = [
      sheetRow({ id: "mine", title: "Mine", mine: true }),
      sheetRow({ id: "shared", title: "Shared", mine: false, owner: "Maya Chen" }),
      sheetRow({ id: "starred", title: "Starred", starred: true }),
      sheetRow({ id: "trash", title: "Trashed", deletedAt: "2026-05-22T12:00:00.000Z" }),
    ];

    expect(filterSheetsByFolder(rows, "all").map((row) => row.id)).toEqual([
      "mine",
      "shared",
      "starred",
    ]);
    expect(filterSheetsByFolder(rows, "shared").map((row) => row.id)).toEqual(["shared"]);
    expect(filterSheetsByFolder(rows, "starred").map((row) => row.id)).toEqual(["starred"]);
    expect(filterSheetsByFolder(rows, "trash").map((row) => row.id)).toEqual(["trash"]);
  });

  it("uses Drive search for app search so matches outside the first page are visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            hits: [
              searchHit({
                objectId: "11111111-1111-4111-8111-111111111111",
                name: "Hidden forecast.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
              searchHit({
                objectId: "22222222-2222-4222-8222-222222222222",
                name: "Hidden brief.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              }),
            ],
          }),
        ),
      ),
    );

    const options = sheetsListFromDriveQueryOptions({ limit: 51, query: "hidden" });
    const rows = await (options.queryFn as () => Promise<readonly SheetListRow[]>)();

    expect(rows.map((row) => row.title)).toEqual(["Hidden forecast.xlsx"]);
    expect(rows[0]?.openMode).toBe("office");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.search", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "hidden",
        folderId: null,
        limit: 51,
      }),
    });
  });
});

function sheetRow(
  overrides: Partial<SheetListRow> & { readonly id: string; readonly title: string },
): SheetListRow {
  return {
    id: overrides.id,
    title: overrides.title,
    owner: overrides.owner ?? "You",
    modified: overrides.modified ?? "May 20",
    shared: overrides.shared ?? 1,
    source: overrides.source ?? "backend",
    ...(overrides.mimeType === undefined ? {} : { mimeType: overrides.mimeType }),
    ...(overrides.formatLabel === undefined ? {} : { formatLabel: overrides.formatLabel }),
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    ...(overrides.mine === undefined ? {} : { mine: overrides.mine }),
    ...(overrides.starred === undefined ? {} : { starred: overrides.starred }),
    ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    ...(overrides.openMode === undefined ? {} : { openMode: overrides.openMode }),
  };
}

function driveEntry(overrides: {
  readonly id: string;
  readonly app: string | null;
  readonly name: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
  readonly preview?: unknown;
  readonly deletedAt?: string | null;
}) {
  return {
    id: overrides.id,
    type: "file",
    name: overrides.name,
    folderId: "44444444-4444-4444-8444-444444444444",
    ownerActorId: null,
    app: overrides.app,
    mimeType: overrides.mimeType ?? "application/vnd.helix.spreadsheet",
    metadata: overrides.metadata ?? {},
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    deletedAt: overrides.deletedAt ?? null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function searchHit(overrides: {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
}) {
  return {
    objectId: overrides.objectId,
    name: overrides.name,
    mimeType: overrides.mimeType,
    byteSize: 1024,
    sha256: null,
    folderId: null,
    preview: "",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}
