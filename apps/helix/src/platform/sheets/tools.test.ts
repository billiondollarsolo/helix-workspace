import { existsSync, readFileSync } from "node:fs";
import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemorySheetsStore } from "./store.js";
import { registerSheetsTools } from "./tools.js";
import { skipUnlessTestCorpus } from "../test/live-suite.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const corpusIt = skipUnlessTestCorpus(
  "Sheets tools (Apache Tika corpus)",
  existsSync("../../test-corpus/apache-tika"),
  "test-corpus/apache-tika",
)
  ? it.skip
  : it;

function readerActor(): Actor {
  return { id: actorId, orgId, type: "user", scopes: ["sheets.read"] };
}

function writerActor(): Actor {
  return { id: actorId, orgId, type: "user", scopes: ["sheets.read", "sheets.write"] };
}

function setup(): { registry: ReturnType<typeof createToolRegistry>; store: InMemorySheetsStore } {
  const store = new InMemorySheetsStore();
  const registry = createToolRegistry();
  registerSheetsTools(registry, { store });
  return { registry, store };
}

describe("sheets tools", () => {
  it("registers read tools as read-safe and write tools as write", () => {
    const { registry } = setup();
    expect(registry.get("sheets.list")).toMatchObject({
      id: "sheets.list",
      permission: "sheets.read",
      sideEffects: "read",
    });
    expect(registry.get("sheets.create")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.copy")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.import-tsv")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.import-ods")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.export")).toMatchObject({
      permission: "sheets.read",
      sideEffects: "read",
    });
    expect(registry.get("sheets.comment.list")).toMatchObject({
      permission: "sheets.read",
      sideEffects: "read",
    });
    expect(registry.get("sheets.comment.create")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.comment.update")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.comment.reopen")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.range.sort")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.delete")?.confirmationRequired).toBe(true);
    expect(registry.get("sheets.tab.delete")?.confirmationRequired).toBe(true);
    expect(registry.get("sheets.comment.delete")?.confirmationRequired).toBe(true);
  });

  it("denies write tools to an actor without the sheets.write scope", async () => {
    const { registry } = setup();
    const result = await registry.invoke(
      "sheets.create",
      { title: "Blocked" },
      { actor: readerActor() },
    );
    expect(result.ok).toBe(false);
  });

  it("creates, gets, updates, and lists a spreadsheet", async () => {
    const { registry } = setup();
    const actor = writerActor();

    const created = await registry.invoke<{ readonly id: string; readonly tabs: unknown[] }>(
      "sheets.create",
      { title: "Renewals", tabNames: ["Customers", "Pipeline"] },
      { actor },
    );
    expect(created.ok).toBe(true);
    const sheetId = created.ok ? created.output.id : "";
    expect(created.ok ? created.output.tabs : []).toHaveLength(2);

    const fetched = await registry.invoke<{ readonly title: string }>(
      "sheets.get",
      { sheetId },
      { actor },
    );
    expect(fetched.ok && fetched.output.title).toBe("Renewals");

    const updated = await registry.invoke<{ readonly title: string }>(
      "sheets.update",
      { sheetId, title: "Renewals 2026" },
      { actor },
    );
    expect(updated.ok && updated.output.title).toBe("Renewals 2026");

    const listed = await registry.invoke<{ readonly total: number; readonly sheets: unknown[] }>(
      "sheets.list",
      {},
      { actor },
    );
    expect(listed.ok && listed.output.total).toBe(1);
  });

  it("copies a spreadsheet with tabs, cells, and metadata", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: readonly { readonly id: string; readonly name: string }[];
    }>("sheets.create", { title: "Forecast", tabNames: ["Plan"] }, { actor });
    expect(created.ok).toBe(true);
    const sheetId = created.ok ? created.output.id : "";
    const tabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";
    await registry.invoke(
      "sheets.cells.update",
      {
        tabId,
        edits: [{ row: 1, col: 1, value: "ARR", format: { bold: true } }],
      },
      { actor },
    );

    const copied = await registry.invoke<{
      readonly id: string;
      readonly title: string;
      readonly metadata: Record<string, unknown>;
      readonly tabs: readonly { readonly id: string; readonly name: string }[];
    }>(
      "sheets.copy",
      { sheetId, title: "Forecast (Copy)", metadata: { createdFrom: "test.copy" } },
      { actor },
    );

    expect(copied.ok).toBe(true);
    expect(copied.ok ? copied.output : undefined).toMatchObject({
      title: "Forecast (Copy)",
      metadata: { createdFrom: "test.copy", copiedFromSheetId: sheetId },
    });
    const copiedTabId = copied.ok ? (copied.output.tabs[0]?.id ?? "") : "";
    expect(copiedTabId).not.toBe(tabId);
    const copiedCells = await registry.invoke<{
      readonly cells: readonly {
        readonly row: number;
        readonly col: number;
        readonly value: string;
        readonly format: Record<string, unknown>;
      }[];
    }>("sheets.tab.get", { tabId: copiedTabId }, { actor });
    expect(copiedCells.ok ? copiedCells.output.cells : []).toContainEqual(
      expect.objectContaining({ row: 1, col: 1, value: "ARR", format: { bold: true } }),
    );
  });

  it("imports CSV text into a native spreadsheet", async () => {
    const { registry } = setup();
    const actor = writerActor();

    const imported = await registry.invoke<{
      readonly id: string;
      readonly title: string;
      readonly metadata: Record<string, unknown>;
      readonly tabs: { readonly id: string; readonly name: string }[];
      readonly import: {
        readonly format: string;
        readonly rowCount: number;
        readonly columnCount: number;
        readonly populatedCellCount: number;
      };
    }>(
      "sheets.import-csv",
      {
        filename: "Renewals.csv",
        folderId: "33333333-3333-4333-8333-333333333333",
        csvText: 'Customer,ARR,Note\nAcme,1200,"quoted, note"\nZenith,,Open',
        metadata: { source: "test" },
      },
      { actor },
    );

    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.output.title : "").toBe("Renewals");
    expect(imported.ok ? imported.output.tabs[0]?.name : "").toBe("Renewals");
    expect(imported.ok ? imported.output.metadata : {}).toMatchObject({
      app: "sheets",
      importedFrom: "csv",
      sourceFilename: "Renewals.csv",
      folderId: "33333333-3333-4333-8333-333333333333",
      source: "test",
    });
    expect(imported.ok ? imported.output.import : undefined).toMatchObject({
      format: "csv",
      rowCount: 3,
      columnCount: 3,
      populatedCellCount: 8,
    });

    const tabId = imported.ok ? (imported.output.tabs[0]?.id ?? "") : "";
    const tabRead = await registry.invoke<{
      readonly cells: Array<{ readonly row: number; readonly col: number; readonly value: string }>;
    }>("sheets.tab.get", { tabId }, { actor });
    expect(tabRead.ok ? tabRead.output.cells : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 0, col: 0, value: "Customer" }),
        expect.objectContaining({ row: 1, col: 2, value: "quoted, note" }),
        expect.objectContaining({ row: 2, col: 2, value: "Open" }),
      ]),
    );
    const windowedTabRead = await registry.invoke<{
      readonly cells: Array<{ readonly row: number; readonly col: number; readonly value: string }>;
    }>(
      "sheets.tab.get",
      { tabId, window: { startRow: 1, startCol: 2, endRow: 1, endCol: 2 } },
      { actor },
    );
    expect(windowedTabRead.ok ? windowedTabRead.output.cells : []).toEqual([
      expect.objectContaining({ row: 1, col: 2, value: "quoted, note" }),
    ]);
  });

  it("imports TSV text into a native spreadsheet", async () => {
    const { registry } = setup();
    const actor = writerActor();

    const imported = await registry.invoke<{
      readonly id: string;
      readonly title: string;
      readonly metadata: Record<string, unknown>;
      readonly tabs: { readonly id: string; readonly name: string }[];
      readonly import: {
        readonly format: string;
        readonly rowCount: number;
        readonly columnCount: number;
        readonly populatedCellCount: number;
      };
    }>(
      "sheets.import-tsv",
      {
        filename: "Renewals.tsv",
        folderId: "33333333-3333-4333-8333-333333333333",
        tsvText: "Customer\tARR\tNote\nAcme\t1200\tTab retained\nZenith\t\tOpen",
        metadata: { source: "test" },
      },
      { actor },
    );

    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.output.title : "").toBe("Renewals");
    expect(imported.ok ? imported.output.tabs[0]?.name : "").toBe("Renewals");
    expect(imported.ok ? imported.output.metadata : {}).toMatchObject({
      app: "sheets",
      importedFrom: "tsv",
      sourceFilename: "Renewals.tsv",
      folderId: "33333333-3333-4333-8333-333333333333",
      source: "test",
    });
    expect(imported.ok ? imported.output.import : undefined).toMatchObject({
      format: "tsv",
      rowCount: 3,
      columnCount: 3,
      populatedCellCount: 8,
    });

    const tabId = imported.ok ? (imported.output.tabs[0]?.id ?? "") : "";
    const tabRead = await registry.invoke<{
      readonly cells: Array<{ readonly row: number; readonly col: number; readonly value: string }>;
    }>("sheets.tab.get", { tabId }, { actor });
    expect(tabRead.ok ? tabRead.output.cells : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 0, col: 0, value: "Customer" }),
        expect.objectContaining({ row: 1, col: 2, value: "Tab retained" }),
        expect.objectContaining({ row: 2, col: 2, value: "Open" }),
      ]),
    );
  });

  it("imports XLSX workbooks into native spreadsheet tabs", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet("Summary");
    summary.getCell(1, 1).value = "Customer";
    summary.getCell(1, 2).value = "ARR";
    summary.getCell(2, 1).value = "Acme";
    summary.getCell(2, 2).value = 1200;
    summary.getCell(2, 2).numFmt = "#,##0.00";
    summary.getCell(3, 2).value = { formula: "SUM(B2:B2)" };
    const notes = workbook.addWorksheet("Notes");
    notes.getCell(1, 1).value = { richText: [{ text: "Launch" }, { text: " plan" }] };
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const imported = await registry.invoke<{
      readonly title: string;
      readonly metadata: Record<string, unknown>;
      readonly tabs: { readonly id: string; readonly name: string }[];
      readonly import: {
        readonly format: string;
        readonly sheetCount: number;
        readonly populatedCellCount: number;
      };
    }>(
      "sheets.import-xlsx",
      {
        filename: "Forecast.xlsx",
        folderId: "33333333-3333-4333-8333-333333333333",
        contentBase64: buffer.toString("base64"),
        metadata: { source: "test" },
      },
      { actor },
    );

    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.output.title : "").toBe("Forecast");
    expect(imported.ok ? imported.output.tabs.map((tab) => tab.name) : []).toEqual([
      "Summary",
      "Notes",
    ]);
    expect(imported.ok ? imported.output.metadata : {}).toMatchObject({
      app: "sheets",
      importedFrom: "xlsx",
      sourceFilename: "Forecast.xlsx",
      folderId: "33333333-3333-4333-8333-333333333333",
    });
    expect(imported.ok ? imported.output.import : undefined).toMatchObject({
      format: "xlsx",
      sheetCount: 2,
      populatedCellCount: 6,
    });

    const firstTabId = imported.ok ? (imported.output.tabs[0]?.id ?? "") : "";
    const tabRead = await registry.invoke<{
      readonly cells: Array<{
        readonly row: number;
        readonly col: number;
        readonly value: string;
        readonly format: Record<string, unknown>;
      }>;
    }>("sheets.tab.get", { tabId: firstTabId }, { actor });
    expect(tabRead.ok ? tabRead.output.cells : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 1,
          col: 1,
          value: "1200",
          format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
        }),
        expect.objectContaining({ row: 2, col: 1, value: "=SUM(B2:B2)" }),
      ]),
    );
  });

  it("imports legacy and binary Excel workbooks through the same spreadsheet importer", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const XLSX = await import("xlsx");

    for (const fixture of [
      { filename: "Legacy forecast.xls", bookType: "biff8" as const, format: "xls" },
      { filename: "Binary forecast.xlsb", bookType: "xlsb" as const, format: "xlsb" },
    ]) {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet([
        ["Customer", "ARR"],
        ["Acme", 1200],
      ]);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Legacy");
      const output: unknown = XLSX.write(workbook, { type: "buffer", bookType: fixture.bookType });
      const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array);

      const imported = await registry.invoke<{
        readonly title: string;
        readonly metadata: Record<string, unknown>;
        readonly tabs: { readonly id: string; readonly name: string }[];
        readonly import: { readonly format: string };
      }>(
        "sheets.import-xlsx",
        {
          filename: fixture.filename,
          contentBase64: Buffer.from(buffer).toString("base64"),
          metadata: { source: "legacy-excel-test" },
        },
        { actor },
      );

      expect(imported.ok).toBe(true);
      expect(imported.ok ? imported.output.title : "").toContain("forecast");
      expect(imported.ok ? imported.output.metadata : {}).toMatchObject({
        importedFrom: fixture.format,
        sourceFilename: fixture.filename,
      });
      expect(imported.ok ? imported.output.import : undefined).toMatchObject({
        format: fixture.format,
      });
      expect(imported.ok ? imported.output.tabs.map((tab) => tab.name) : []).toEqual(["Legacy"]);

      const tabId = imported.ok ? (imported.output.tabs[0]?.id ?? "") : "";
      const tabRead = await registry.invoke<{
        readonly cells: Array<{
          readonly row: number;
          readonly col: number;
          readonly value: string;
          readonly format: Record<string, unknown>;
        }>;
      }>("sheets.tab.get", { tabId }, { actor });
      expect(tabRead.ok ? tabRead.output.cells : []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 0, col: 0, value: "Customer" }),
          expect.objectContaining({
            row: 1,
            col: 1,
            value: "1200",
          }),
        ]),
      );
    }
  });

  corpusIt("sanitizes corpus XLSB workbook tab names before storing them", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const buffer = readFileSync("../../test-corpus/apache-tika/microsoft/testEXCEL.xlsb");

    const imported = await registry.invoke<{
      readonly tabs: { readonly id: string; readonly name: string }[];
    }>(
      "sheets.import-xlsx",
      {
        filename: "testEXCEL.xlsb",
        contentBase64: buffer.toString("base64"),
        metadata: { source: "corpus-xlsb-test" },
      },
      { actor },
    );

    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.output.tabs.map((tab) => tab.name) : []).toEqual([
      "Sheet 1",
      "Sheet 2",
      "Sheet 3",
    ]);

    const tabId = imported.ok ? (imported.output.tabs[0]?.id ?? "") : "";
    const tabRead = await registry.invoke<{
      readonly cells: Array<{ readonly row: number; readonly col: number; readonly value: string }>;
    }>("sheets.tab.get", { tabId }, { actor });
    expect(tabRead.ok ? tabRead.output.cells : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 0,
          col: 0,
          value: "This is an example spreadsheet created with Microsoft Excel 2007 Beta 2.",
        }),
      ]),
    );
  });

  it("imports ODS workbooks into native spreadsheet tabs", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", {
      compression: "STORE",
    });
    zip.file(
      "content.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="Summary">
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>Customer</text:p></table:table-cell>
          <table:table-cell table:number-columns-repeated="1"/>
          <table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>Acme</text:p></table:table-cell>
          <table:table-cell office:value-type="float" office:value="1200"><text:p>1,200</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell/>
          <table:table-cell table:formula="of:=SUM([.B2:.B2])" office:value-type="float" office:value="1200"><text:p>1200</text:p></table:table-cell>
        </table:table-row>
      </table:table>
      <table:table table:name="Notes">
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>Launch notes</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`,
    );
    zip.file(
      "META-INF/manifest.xml",
      `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`,
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const imported = await registry.invoke<{
      readonly title: string;
      readonly metadata: Record<string, unknown>;
      readonly tabs: { readonly id: string; readonly name: string }[];
      readonly import: {
        readonly format: string;
        readonly sheetCount: number;
        readonly populatedCellCount: number;
      };
    }>(
      "sheets.import-ods",
      {
        filename: "Forecast.ods",
        folderId: "33333333-3333-4333-8333-333333333333",
        contentBase64: buffer.toString("base64"),
        metadata: { source: "test" },
      },
      { actor },
    );

    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.output.title : "").toBe("Forecast");
    expect(imported.ok ? imported.output.tabs.map((tab) => tab.name) : []).toEqual([
      "Summary",
      "Notes",
    ]);
    expect(imported.ok ? imported.output.metadata : {}).toMatchObject({
      app: "sheets",
      importedFrom: "ods",
      sourceFilename: "Forecast.ods",
      folderId: "33333333-3333-4333-8333-333333333333",
    });
    expect(imported.ok ? imported.output.import : undefined).toMatchObject({
      format: "ods",
      sheetCount: 2,
      populatedCellCount: 6,
    });

    const firstTabId = imported.ok ? (imported.output.tabs[0]?.id ?? "") : "";
    const tabRead = await registry.invoke<{
      readonly cells: Array<{
        readonly row: number;
        readonly col: number;
        readonly value: string;
      }>;
    }>("sheets.tab.get", { tabId: firstTabId }, { actor });
    expect(tabRead.ok ? tabRead.output.cells : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 0, col: 0, value: "Customer" }),
        expect.objectContaining({ row: 0, col: 2, value: "Region" }),
        expect.objectContaining({ row: 1, col: 1, value: "1200" }),
        expect.objectContaining({ row: 2, col: 1, value: "=SUM(B2:B2)" }),
      ]),
    );
  });

  it("exports native spreadsheets as delimited text and XLSX workbooks", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string; readonly name: string }[];
    }>("sheets.create", { title: "Forecast Export", tabNames: ["Summary", "Notes"] }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";
    const secondTabId = created.ok ? (created.output.tabs[1]?.id ?? "") : "";

    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          { row: 0, col: 0, value: "Customer" },
          { row: 0, col: 1, value: "ARR" },
          { row: 1, col: 0, value: "Acme, Inc." },
          {
            row: 1,
            col: 1,
            value: "1200",
            format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
          },
          { row: 2, col: 1, value: "=SUM(B2:B2)" },
        ],
      },
      { actor },
    );
    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: secondTabId,
        edits: [{ row: 0, col: 0, value: "Launch notes" }],
      },
      { actor },
    );

    const csv = await registry.invoke<{
      readonly filename: string;
      readonly mimeType: string;
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId, format: "csv", tabId: firstTabId }, { actor: readerActor() });
    expect(csv.ok).toBe(true);
    expect(csv.ok ? csv.output.filename : "").toBe("forecast-export-summary.csv");
    expect(csv.ok ? csv.output.mimeType : "").toBe("text/csv");
    expect(csv.ok ? Buffer.from(csv.output.contentBase64, "base64").toString("utf8") : "").toBe(
      'Customer,ARR\n"Acme, Inc.",1200\n,1200',
    );
    expect(csv.ok ? csv.output.metadata : {}).toMatchObject({
      generatedBy: "helix.sheets.export.csv",
      tabId: firstTabId,
      tabName: "Summary",
    });

    const xlsx = await registry.invoke<{
      readonly filename: string;
      readonly mimeType: string;
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId, format: "xlsx" }, { actor: readerActor() });
    expect(xlsx.ok).toBe(true);
    expect(xlsx.ok ? xlsx.output.filename : "").toBe("forecast-export.xlsx");
    expect(xlsx.ok ? xlsx.output.mimeType : "").toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(xlsx.ok ? xlsx.output.metadata : {}).toMatchObject({
      generatedBy: "helix.sheets.export.xlsx",
      sheetCount: 2,
      populatedCellCount: 6,
    });

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const bytes = Buffer.from(xlsx.ok ? xlsx.output.contentBase64 : "", "base64");
    const workbookBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(workbookBuffer).set(bytes);
    await workbook.xlsx.load(workbookBuffer);
    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual(["Summary", "Notes"]);
    const summary = workbook.getWorksheet("Summary");
    expect(summary?.getCell(2, 1).value).toBe("Acme, Inc.");
    expect(summary?.getCell(2, 2).value).toBe(1200);
    expect(summary?.getCell(2, 2).numFmt).toBe("#,##0.00");
    expect(summary?.getCell(3, 2).value).toMatchObject({ formula: "SUM(B2:B2)" });
    expect(workbook.getWorksheet("Notes")?.getCell(1, 1).value).toBe("Launch notes");

    const ods = await registry.invoke<{
      readonly filename: string;
      readonly mimeType: string;
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId, format: "ods" }, { actor: readerActor() });
    expect(ods.ok).toBe(true);
    expect(ods.ok ? ods.output.filename : "").toBe("forecast-export.ods");
    expect(ods.ok ? ods.output.mimeType : "").toBe(
      "application/vnd.oasis.opendocument.spreadsheet",
    );
    expect(ods.ok ? ods.output.metadata : {}).toMatchObject({
      generatedBy: "helix.sheets.export.ods",
      sheetCount: 2,
      populatedCellCount: 6,
    });

    const JSZip = (await import("jszip")).default;
    const odsZip = await JSZip.loadAsync(
      Buffer.from(ods.ok ? ods.output.contentBase64 : "", "base64"),
    );
    await expect(odsZip.file("mimetype")?.async("string")).resolves.toBe(
      "application/vnd.oasis.opendocument.spreadsheet",
    );
    const contentXml = await odsZip.file("content.xml")?.async("string");
    const manifestXml = await odsZip.file("META-INF/manifest.xml")?.async("string");
    expect(contentXml).toContain('table:name="Summary"');
    expect(contentXml).toContain('table:name="Notes"');
    expect(contentXml).toContain('table:formula="of:=SUM([.B2:.B2])"');
    expect(manifestXml).toContain('manifest:full-path="/"');
    expect(manifestXml).toContain('manifest:full-path="content.xml"');
    expect(manifestXml).toContain('manifest:full-path="meta.xml"');
  });

  it("exports stored cell styles and manual list validation to XLSX and ODS", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Styled Export" }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    await registry.invoke(
      "sheets.update",
      {
        sheetId,
        metadata: {
          namedRanges: [
            {
              id: "named-status-export",
              tabId: firstTabId,
              name: "Status_List",
              range: { startRow: 0, startCol: 3, endRow: 1, endCol: 3 },
            },
          ],
        },
      },
      { actor },
    );
    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 0,
            value: "Approved",
            format: {
              fillColor: "#fef3c7",
              textColor: "#166534",
              bold: true,
              italic: true,
              dataValidation: {
                type: "list",
                choices: ["Approved", "Pending"],
                mode: "reject",
              },
            },
          },
          {
            row: 0,
            col: 1,
            value: "Bordered",
            format: { borders: { top: true, right: true, bottom: true, left: true } },
          },
          {
            row: 0,
            col: 2,
            value: "150",
            format: {
              conditionalFormat: {
                type: "greaterThan100",
                operator: "greaterThan",
                value: 100,
                fillColor: "#dcfce7",
                textColor: "#166534",
              },
            },
          },
          { row: 0, col: 3, value: "Ready" },
          { row: 1, col: 3, value: "Blocked" },
          {
            row: 0,
            col: 4,
            value: "Ready",
            format: {
              dataValidation: {
                type: "list",
                namedRangeId: "named-status-export",
                mode: "reject",
              },
            },
          },
          {
            row: 0,
            col: 5,
            value: "Ready",
            format: {
              conditionalFormat: {
                type: "customFormula",
                formula: '=VALUE="Ready"',
                fillColor: "#dbeafe",
                textColor: "#1d4ed8",
              },
            },
          },
          {
            row: 0,
            col: 6,
            value: "Needs review",
            format: {
              conditionalFormat: {
                type: "textContains",
                operator: "containsText",
                text: "review",
                fillColor: "#fef3c7",
                textColor: "#92400e",
              },
            },
          },
        ],
      },
      { actor },
    );
    const comment = await registry.invoke<{ readonly id: string }>(
      "sheets.comment.create",
      {
        sheetId,
        body: "Check approval status",
        anchor: {
          type: "sheet-range",
          tabId: firstTabId,
          label: "A1",
          range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        },
      },
      { actor },
    );
    expect(comment.ok).toBe(true);
    await registry.invoke(
      "sheets.comment.create",
      {
        sheetId,
        parentCommentId: comment.ok ? comment.output.id : "",
        body: "Approved by finance",
        anchor: {
          type: "sheet-range",
          tabId: firstTabId,
          label: "A1",
          range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        },
      },
      { actor },
    );

    const xlsx = await registry.invoke<{
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId, format: "xlsx" }, { actor: readerActor() });
    expect(xlsx.ok).toBe(true);
    expect(xlsx.ok ? xlsx.output.metadata : {}).toMatchObject({
      commentCount: 2,
      namedRangeCount: 1,
      conditionalFormatRuleCount: 3,
    });

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const bytes = Buffer.from(xlsx.ok ? xlsx.output.contentBase64 : "", "base64");
    const workbookBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(workbookBuffer).set(bytes);
    await workbook.xlsx.load(workbookBuffer);
    const worksheet = workbook.worksheets[0];
    expect(worksheet).toBeDefined();
    if (worksheet === undefined) {
      throw new Error("Expected exported XLSX to include a worksheet.");
    }
    const styledCell = worksheet.getCell(1, 1);
    expect(styledCell.fill).toMatchObject({ fgColor: { argb: "FFFEF3C7" } });
    expect(styledCell.font).toMatchObject({
      bold: true,
      italic: true,
      color: { argb: "FF166534" },
    });
    expect(styledCell.dataValidation).toMatchObject({
      type: "list",
      formulae: ['"Approved,Pending"'],
    });
    expect(styledCell.note).toContain("Check approval status");
    expect(styledCell.note).toContain("Reply: ");
    expect(styledCell.note).toContain("Approved by finance");
    const borderedCell = worksheet.getCell(1, 2);
    expect(borderedCell.border.top).toMatchObject({ style: "thin" });
    expect(borderedCell.border.right).toMatchObject({ style: "thin" });
    expect(borderedCell.border.bottom).toMatchObject({ style: "thin" });
    expect(borderedCell.border.left).toMatchObject({ style: "thin" });
    expect(workbook.definedNames.model).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Status_List", ranges: ["Sheet1!$D$1:$D$2"] }),
      ]),
    );
    expect(worksheet.getCell(1, 5).dataValidation).toMatchObject({
      type: "list",
      formulae: ["Status_List"],
    });
    const JSZip = (await import("jszip")).default;
    const xlsxZip = await JSZip.loadAsync(bytes);
    const sheetXml = await xlsxZip.file("xl/worksheets/sheet1.xml")?.async("string");
    expect(sheetXml).toContain('<conditionalFormatting sqref="C1">');
    expect(sheetXml).toContain('type="cellIs"');
    expect(sheetXml).toContain('operator="greaterThan"');
    expect(sheetXml).toContain("<formula>100</formula>");
    expect(sheetXml).toContain('<conditionalFormatting sqref="F1">');
    expect(sheetXml).toContain('type="expression"');
    expect(sheetXml).toContain("<formula>F1=&quot;Ready&quot;</formula>");
    expect(sheetXml).toContain('<conditionalFormatting sqref="G1">');
    expect(sheetXml).toContain("<formula>ISNUMBER(SEARCH(&quot;review&quot;,G1))</formula>");
    const conditionalFormattings = (
      worksheet as unknown as {
        readonly conditionalFormattings?: ReadonlyArray<{
          readonly ref: string;
          readonly rules: readonly unknown[];
        }>;
      }
    ).conditionalFormattings;
    expect(conditionalFormattings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "C1",
          rules: [
            expect.objectContaining({
              type: "cellIs",
              operator: "greaterThan",
              formulae: ["100"],
            }),
          ],
        }),
        expect.objectContaining({
          ref: "F1",
          rules: [
            expect.objectContaining({
              type: "expression",
              formulae: ['F1="Ready"'],
            }),
          ],
        }),
        expect.objectContaining({
          ref: "G1",
          rules: [
            expect.objectContaining({
              type: "expression",
              formulae: ['ISNUMBER(SEARCH("review",G1))'],
            }),
          ],
        }),
      ]),
    );

    const ods = await registry.invoke<{
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId, format: "ods" }, { actor: readerActor() });
    expect(ods.ok).toBe(true);
    expect(ods.ok ? ods.output.metadata : {}).toMatchObject({
      commentCount: 2,
      namedRangeCount: 1,
    });

    const odsZip = await JSZip.loadAsync(
      Buffer.from(ods.ok ? ods.output.contentBase64 : "", "base64"),
    );
    const contentXml = await odsZip.file("content.xml")?.async("string");
    expect(contentXml).toContain('table:style-name="ce1"');
    expect(contentXml).toContain('table:style-name="ce2"');
    expect(contentXml).toContain('table:style-name="ce3"');
    expect(contentXml).toContain('fo:background-color="#fef3c7"');
    expect(contentXml).toContain('fo:background-color="#dcfce7"');
    expect(contentXml).toContain('fo:color="#166534"');
    expect(contentXml).toContain("<style:map");
    expect(contentXml).toContain("cell-content()&gt;100");
    expect(contentXml).toContain("is-true-formula(cell-content()=&quot;Ready&quot;)");
    expect(contentXml).toContain(
      "is-true-formula(ISNUMBER(SEARCH(&quot;review&quot;;cell-content())))",
    );
    expect(contentXml).toContain('style:apply-style-name="cf');
    expect(contentXml).toContain('fo:font-weight="bold"');
    expect(contentXml).toContain('fo:font-style="italic"');
    expect(contentXml).toContain('fo:border-top="0.75pt solid #111827"');
    expect(contentXml).toContain('fo:border-right="0.75pt solid #111827"');
    expect(contentXml).toContain("<table:content-validations>");
    expect(contentXml).toContain('table:validation-name="dv1"');
    expect(contentXml).toContain('table:validation-name="dv2"');
    expect(contentXml).toContain("Approved");
    expect(contentXml).toContain("Pending");
    expect(contentXml).toContain("Ready");
    expect(contentXml).toContain("Blocked");
    expect(contentXml).toContain("<office:annotation>");
    expect(contentXml).toContain("Check approval status");
    expect(contentXml).toContain("Approved by finance");
  });

  it("exports cross-tab named-range list validation to XLSX defined names", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Cross Tab Validation", tabNames: ["Entry", "Lists"] }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const entryTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";
    const listsTabId = created.ok ? (created.output.tabs[1]?.id ?? "") : "";

    await registry.invoke(
      "sheets.update",
      {
        sheetId,
        metadata: {
          namedRanges: [
            {
              id: "named-status-cross-tab",
              tabId: listsTabId,
              name: "Status_List",
              range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
            },
          ],
        },
      },
      { actor },
    );
    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: listsTabId,
        edits: [
          { row: 0, col: 0, value: "Ready" },
          { row: 1, col: 0, value: "Blocked" },
        ],
      },
      { actor },
    );
    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: entryTabId,
        edits: [
          {
            row: 0,
            col: 0,
            value: "Ready",
            format: {
              dataValidation: {
                type: "list",
                namedRangeId: "named-status-cross-tab",
                mode: "reject",
              },
            },
          },
        ],
      },
      { actor },
    );

    const xlsx = await registry.invoke<{
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId, format: "xlsx" }, { actor: readerActor() });
    expect(xlsx.ok).toBe(true);
    expect(xlsx.ok ? xlsx.output.metadata : {}).toMatchObject({
      namedRangeCount: 1,
    });

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const bytes = Buffer.from(xlsx.ok ? xlsx.output.contentBase64 : "", "base64");
    const workbookBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(workbookBuffer).set(bytes);
    await workbook.xlsx.load(workbookBuffer);
    const entrySheet = workbook.getWorksheet("Entry");
    expect(entrySheet).toBeDefined();
    if (entrySheet === undefined) {
      throw new Error("Expected Entry worksheet.");
    }
    expect(workbook.definedNames.model).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Status_List", ranges: ["Lists!$A$1:$A$2"] }),
      ]),
    );
    expect(entrySheet.getCell(1, 1).dataValidation).toMatchObject({
      type: "list",
      formulae: ["Status_List"],
    });
  });

  it("manages tabs and batch cell edits through the tools", async () => {
    const { registry } = setup();
    const actor = writerActor();

    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Grid" }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const newTab = await registry.invoke<{ readonly id: string; readonly name: string }>(
      "sheets.tab.create",
      { sheetId, name: "Q3" },
      { actor },
    );
    expect(newTab.ok && newTab.output.name).toBe("Q3");

    const cells = await registry.invoke<{ readonly cells: unknown[] }>(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          { row: 0, col: 0, value: "Customer" },
          { row: 0, col: 1, value: "ARR" },
        ],
      },
      { actor },
    );
    expect(cells.ok && cells.output.cells).toHaveLength(2);

    const tabRead = await registry.invoke<{ readonly cells: unknown[] }>(
      "sheets.tab.get",
      { tabId: firstTabId },
      { actor },
    );
    expect(tabRead.ok && tabRead.output.cells).toHaveLength(2);

    const deleted = await registry.invoke<{ readonly tabId: string }>(
      "sheets.tab.delete",
      { tabId: firstTabId },
      { actor },
    );
    expect(deleted.ok && deleted.output.tabId).toBe(firstTabId);
  });

  it("persists cell formatting metadata through the update tool", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Validation" }, { actor });
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const cells = await registry.invoke<{
      readonly cells: Array<{
        readonly row: number;
        readonly col: number;
        readonly value: string;
        readonly format: Record<string, unknown>;
      }>;
    }>(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 0,
            value: "not-a-number",
            format: { dataValidation: { type: "number" } },
          },
          {
            row: 0,
            col: 1,
            value: "Pending",
            format: { dataValidation: { type: "list", choices: ["Approved", "Pending"] } },
          },
          {
            row: 1,
            col: 1,
            value: "150",
            format: {
              numberFormat: "date",
              conditionalFormat: {
                type: "greaterThan100",
                operator: "greaterThan",
                value: 100,
                fillColor: "#dcfce7",
                textColor: "#166534",
              },
            },
          },
          {
            row: 2,
            col: 0,
            value: "1234.567",
            format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
          },
          {
            row: 3,
            col: 0,
            value: "Launch plan",
            format: { linkUrl: "https://example.test/launch-plan" },
          },
        ],
      },
      { actor },
    );

    expect(cells.ok).toBe(true);
    const validationCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 0 && cell.col === 0)
      : undefined;
    expect(validationCell).toMatchObject({
      value: "not-a-number",
      format: { dataValidation: { type: "number" } },
    });
    const listValidationCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 0 && cell.col === 1)
      : undefined;
    expect(listValidationCell).toMatchObject({
      value: "Pending",
      format: { dataValidation: { type: "list", choices: ["Approved", "Pending"] } },
    });
    const formattedCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 1 && cell.col === 1)
      : undefined;
    expect(formattedCell).toMatchObject({
      value: "150",
      format: {
        numberFormat: "date",
        conditionalFormat: {
          type: "greaterThan100",
          operator: "greaterThan",
          value: 100,
          fillColor: "#dcfce7",
          textColor: "#166534",
        },
      },
    });
    const customFormattedCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 2 && cell.col === 0)
      : undefined;
    expect(customFormattedCell).toMatchObject({
      value: "1234.567",
      format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
    });
    const linkedCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 3 && cell.col === 0)
      : undefined;
    expect(linkedCell).toMatchObject({
      value: "Launch plan",
      format: { linkUrl: "https://example.test/launch-plan" },
    });

    const tabRead = await registry.invoke<{
      readonly cells: Array<{
        readonly row: number;
        readonly col: number;
        readonly format: Record<string, unknown>;
      }>;
    }>("sheets.tab.get", { tabId: firstTabId }, { actor });

    const readFormats = tabRead.ok
      ? new Map(
          tabRead.output.cells.map((cell) => [
            `${String(cell.row)}:${String(cell.col)}`,
            cell.format,
          ]),
        )
      : new Map<string, Record<string, unknown>>();
    expect(readFormats.get("0:0")).toEqual({ dataValidation: { type: "number" } });
    expect(readFormats.get("0:1")).toEqual({
      dataValidation: { type: "list", choices: ["Approved", "Pending"] },
    });
    expect(readFormats.get("1:1")).toEqual({
      numberFormat: "date",
      conditionalFormat: {
        type: "greaterThan100",
        operator: "greaterThan",
        value: 100,
        fillColor: "#dcfce7",
        textColor: "#166534",
      },
    });
    expect(readFormats.get("2:0")).toEqual({
      numberFormat: "custom",
      customNumberFormat: "#,##0.00",
    });
    expect(readFormats.get("3:0")).toEqual({ linkUrl: "https://example.test/launch-plan" });
  });

  it("sorts a selected range through the range sort tool", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Sort" }, { actor });
    const tabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    await registry.invoke(
      "sheets.cells.update",
      {
        tabId,
        edits: [
          { row: 1, col: 0, value: "Zeta", format: { fillColor: "#fef3c7" } },
          { row: 1, col: 1, value: "=A2", format: { fillColor: "#fef3c7" } },
          { row: 2, col: 0, value: "Alpha" },
          { row: 2, col: 1, value: "=$A$3+A3" },
        ],
      },
      { actor },
    );

    const sorted = await registry.invoke<{
      readonly cells: Array<{
        readonly row: number;
        readonly col: number;
        readonly value: string;
        readonly format: Record<string, unknown>;
      }>;
    }>(
      "sheets.range.sort",
      {
        tabId,
        direction: "asc",
        range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
      },
      { actor },
    );

    expect(sorted.ok && sorted.output.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 1, col: 0, value: "Alpha", format: {} }),
        expect.objectContaining({ row: 1, col: 1, value: "=$A$3+A2", format: {} }),
        expect.objectContaining({
          row: 2,
          col: 0,
          value: "Zeta",
          format: { fillColor: "#fef3c7" },
        }),
        expect.objectContaining({
          row: 2,
          col: 1,
          value: "=A3",
          format: { fillColor: "#fef3c7" },
        }),
      ]),
    );
  });

  it("accepts sectioned custom number formats through the update tool", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Sectioned formats" }, { actor });
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const cells = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 0,
            value: "-1234.567",
            format: {
              numberFormat: "custom",
              customNumberFormat: "$#,##0.00;[Red]($#,##0.00);$0.00;@",
            },
          },
        ],
      },
      { actor },
    );

    expect(cells.ok).toBe(true);
  });

  it("rejects invalid values for reject-mode data validation through the update tool", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Hard validation" }, { actor });
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const valid = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 0,
            value: "123",
            format: { dataValidation: { type: "number", mode: "reject" } },
          },
        ],
      },
      { actor },
    );
    expect(valid.ok).toBe(true);

    const invalid = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 0, value: "not-a-number" }],
      },
      { actor },
    );

    expect(invalid.ok).toBe(false);

    const validUrl = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 1,
            value: "https://example.test/report",
            format: { dataValidation: { type: "url", mode: "reject" } },
          },
        ],
      },
      { actor },
    );
    expect(validUrl.ok).toBe(true);

    const invalidUrl = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 1, value: "not-a-url" }],
      },
      { actor },
    );
    expect(invalidUrl.ok).toBe(false);

    const validDate = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 2,
            value: "2026-05-25",
            format: { dataValidation: { type: "date", mode: "reject" } },
          },
        ],
      },
      { actor },
    );
    expect(validDate.ok).toBe(true);

    const invalidDate = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 2, value: "2026-02-31" }],
      },
      { actor },
    );
    expect(invalidDate.ok).toBe(false);

    const validGbDate = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 5,
            value: "31/05/2026",
            format: { dataValidation: { type: "date", mode: "reject", locale: "en-GB" } },
          },
        ],
      },
      { actor },
    );
    expect(validGbDate.ok).toBe(true);

    const invalidGbUsDate = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 5, value: "05/31/2026" }],
      },
      { actor },
    );
    expect(invalidGbUsDate.ok).toBe(false);

    const invalidGbRolloverDate = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 5, value: "31/02/2026" }],
      },
      { actor },
    );
    expect(invalidGbRolloverDate.ok).toBe(false);

    const invalidDateLocale = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 6,
            value: "31/05/2026",
            format: { dataValidation: { type: "date", mode: "reject", locale: "fr-FR" } },
          },
        ],
      },
      { actor },
    );
    expect(invalidDateLocale.ok).toBe(false);

    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 4, value: "50" }],
      },
      { actor },
    );
    const validFormula = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 3,
            value: "60",
            format: {
              dataValidation: { type: "customFormula", mode: "reject", formula: "=VALUE>E1" },
            },
          },
        ],
      },
      { actor },
    );
    expect(validFormula.ok).toBe(true);

    const invalidFormula = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 3, value: "40" }],
      },
      { actor },
    );
    expect(invalidFormula.ok).toBe(false);
  });

  it("enforces reject-mode list validation from named ranges through the update tool", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Named validation" }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const metadataUpdate = await registry.invoke(
      "sheets.update",
      {
        sheetId,
        metadata: {
          namedRanges: [
            {
              id: "named-status",
              tabId: firstTabId,
              name: "Status_List",
              range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
            },
          ],
        },
      },
      { actor },
    );
    expect(metadataUpdate.ok).toBe(true);

    const valid = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          { row: 0, col: 0, value: "Approved" },
          { row: 1, col: 0, value: "Pending" },
          {
            row: 0,
            col: 1,
            value: "Pending",
            format: {
              dataValidation: { type: "list", mode: "reject", namedRangeId: "named-status" },
            },
          },
        ],
      },
      { actor },
    );
    expect(valid.ok).toBe(true);

    const invalid = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [{ row: 0, col: 1, value: "Denied" }],
      },
      { actor },
    );
    expect(invalid.ok).toBe(false);
  });

  it("rejects unsupported custom number formats through the update tool", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Format validation" }, { actor });
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const cells = await registry.invoke(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          {
            row: 0,
            col: 0,
            value: "1234.567",
            format: { numberFormat: "custom", customNumberFormat: "[Red]#,##0.00" },
          },
        ],
      },
      { actor },
    );

    expect(cells.ok).toBe(false);
  });

  it("creates, lists, and resolves selected-range comments through sheets permissions", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Comments" }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const create = await registry.invoke<{
      readonly id: string;
      readonly sheetId: string;
      readonly body: string;
      readonly anchor: Record<string, unknown>;
      readonly status: string;
    }>(
      "sheets.comment.create",
      {
        sheetId,
        body: "Check renewal math",
        anchor: {
          type: "sheet-range",
          tabId: firstTabId,
          label: "B2:C2",
          range: { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
        },
      },
      { actor },
    );

    expect(create.ok).toBe(true);
    const commentId = create.ok ? create.output.id : "";
    expect(create.ok ? create.output : undefined).toMatchObject({
      sheetId,
      body: "Check renewal math",
      status: "open",
      anchor: { type: "sheet-range", tabId: firstTabId, label: "B2:C2" },
    });

    const invalidTabAnchor = await registry.invoke(
      "sheets.comment.create",
      {
        sheetId,
        body: "Wrong tab",
        anchor: {
          type: "sheet-range",
          tabId: "33333333-3333-4333-8333-333333333333",
          range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        },
      },
      { actor },
    );
    expect(invalidTabAnchor.ok).toBe(false);

    const invalidRangeAnchor = await registry.invoke(
      "sheets.comment.create",
      {
        sheetId,
        body: "Wrong range",
        anchor: {
          type: "sheet-range",
          tabId: firstTabId,
          range: { startRow: -1, startCol: 0, endRow: 0, endCol: 0 },
        },
      },
      { actor },
    );
    expect(invalidRangeAnchor.ok).toBe(false);

    const reply = await registry.invoke<{
      readonly parentCommentId: string | null;
      readonly body: string;
    }>(
      "sheets.comment.create",
      {
        sheetId,
        parentCommentId: commentId,
        body: "Reply with context",
        anchor: {
          type: "sheet-range",
          tabId: firstTabId,
          label: "B2:C2",
          range: { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
        },
      },
      { actor },
    );
    expect(reply.ok ? reply.output : undefined).toMatchObject({
      parentCommentId: commentId,
      body: "Reply with context",
    });

    const listed = await registry.invoke<{
      readonly comments: Array<{ readonly id: string; readonly status: string }>;
    }>("sheets.comment.list", { sheetId, status: "open" }, { actor });
    expect(listed.ok ? listed.output.comments.map((comment) => comment.id) : []).toContain(
      commentId,
    );

    const updated = await registry.invoke<{ readonly id: string; readonly body: string }>(
      "sheets.comment.update",
      { commentId, body: "Check renewal math before close" },
      { actor },
    );
    expect(updated.ok ? updated.output : undefined).toMatchObject({
      id: commentId,
      body: "Check renewal math before close",
    });

    const resolved = await registry.invoke<{ readonly id: string; readonly status: string }>(
      "sheets.comment.resolve",
      { commentId },
      { actor },
    );
    expect(resolved.ok ? resolved.output : undefined).toMatchObject({
      id: commentId,
      status: "resolved",
    });

    const openAfterResolve = await registry.invoke<{ readonly comments: unknown[] }>(
      "sheets.comment.list",
      { sheetId, status: "open" },
      { actor },
    );
    expect(openAfterResolve.ok ? openAfterResolve.output.comments : []).toHaveLength(1);

    const reopened = await registry.invoke<{ readonly id: string; readonly status: string }>(
      "sheets.comment.reopen",
      { commentId },
      { actor },
    );
    expect(reopened.ok ? reopened.output : undefined).toMatchObject({
      id: commentId,
      status: "open",
    });

    const deleted = await registry.invoke<{ readonly id: string }>(
      "sheets.comment.delete",
      { commentId },
      { actor },
    );
    expect(deleted.ok ? deleted.output : undefined).toMatchObject({ id: commentId });

    const allAfterDelete = await registry.invoke<{
      readonly comments: Array<{ readonly id: string }>;
    }>("sheets.comment.list", { sheetId, status: "all" }, { actor });
    expect(
      allAfterDelete.ok ? allAfterDelete.output.comments.map((comment) => comment.id) : [],
    ).not.toContain(commentId);
  });

  it("returns evaluated formula metadata with tab cells", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Formulas" }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";
    await registry.invoke(
      "sheets.update",
      {
        sheetId,
        metadata: {
          namedRanges: [
            {
              id: "named-1",
              tabId: firstTabId,
              name: "Revenue_Range",
              range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
            },
          ],
        },
      },
      { actor },
    );

    const cells = await registry.invoke<{
      readonly cells: Array<{
        readonly row: number;
        readonly col: number;
        readonly value: string;
        readonly formula: string | null;
        readonly calcValue: string | null;
        readonly dependencies: readonly string[];
        readonly formulaError: string | null;
      }>;
    }>(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          { row: 0, col: 0, value: "10" },
          { row: 1, col: 0, value: "20" },
          { row: 2, col: 0, value: "=SUM(A1:A2)" },
          { row: 3, col: 0, value: '=QUERY(A1:A2, "select sum(A)", 0)' },
          { row: 4, col: 0, value: "=SUM(Revenue_Range)" },
          { row: 5, col: 0, value: "=AVERAGE(A1:A2)" },
          { row: 6, col: 0, value: "=MAX(Revenue_Range)" },
        ],
      },
      { actor },
    );

    expect(cells.ok).toBe(true);
    const formulaCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 2 && cell.col === 0)
      : undefined;
    expect(formulaCell).toMatchObject({
      value: "=SUM(A1:A2)",
      formula: "SUM(A1:A2)",
      calcValue: "30",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    const queryCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 3 && cell.col === 0)
      : undefined;
    expect(queryCell).toMatchObject({
      value: '=QUERY(A1:A2, "select sum(A)", 0)',
      formula: 'QUERY(A1:A2, "select sum(A)", 0)',
      calcValue: "30",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    const namedRangeCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 4 && cell.col === 0)
      : undefined;
    expect(namedRangeCell).toMatchObject({
      value: "=SUM(Revenue_Range)",
      formula: "SUM(Revenue_Range)",
      calcValue: "30",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    const averageCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 5 && cell.col === 0)
      : undefined;
    expect(averageCell).toMatchObject({
      value: "=AVERAGE(A1:A2)",
      formula: "AVERAGE(A1:A2)",
      calcValue: "15",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    const maxNamedRangeCell = cells.ok
      ? cells.output.cells.find((cell) => cell.row === 6 && cell.col === 0)
      : undefined;
    expect(maxNamedRangeCell).toMatchObject({
      value: "=MAX(Revenue_Range)",
      formula: "MAX(Revenue_Range)",
      calcValue: "20",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
  });

  it("soft-deletes a spreadsheet", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{ readonly id: string }>(
      "sheets.create",
      { title: "Temp" },
      { actor },
    );
    const sheetId = created.ok ? created.output.id : "";

    const deleted = await registry.invoke<{ readonly deletedAt: string | null }>(
      "sheets.delete",
      { sheetId },
      { actor },
    );
    expect(deleted.ok && deleted.output.deletedAt).not.toBeNull();

    const fetch = await registry.invoke("sheets.get", { sheetId }, { actor });
    expect(fetch.ok).toBe(false);
  });

  it("rejects invalid input via the zod schema", async () => {
    const { registry } = setup();
    const result = await registry.invoke("sheets.create", { title: "" }, { actor: writerActor() });
    expect(result.ok).toBe(false);
  });
});
