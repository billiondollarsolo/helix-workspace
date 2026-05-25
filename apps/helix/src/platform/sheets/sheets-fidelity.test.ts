import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemorySheetsStore } from "./store.js";
import { registerSheetsTools } from "./tools.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

function writerActor(): Actor {
  return { id: actorId, orgId, type: "user", scopes: ["sheets.read", "sheets.write"] };
}

function readerActor(): Actor {
  return { id: actorId, orgId, type: "user", scopes: ["sheets.read"] };
}

function setup(): { registry: ReturnType<typeof createToolRegistry>; store: InMemorySheetsStore } {
  const store = new InMemorySheetsStore();
  const registry = createToolRegistry();
  registerSheetsTools(registry, { store });
  return { registry, store };
}

describe("Sheets XLSX/ODS fidelity gate", () => {
  it("round-trips current workbook fidelity guarantees through XLSX and ODS", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string; readonly name: string }[];
    }>("sheets.create", { title: "Fidelity Source", tabNames: ["Summary", "Notes"] }, { actor });
    expect(created.ok).toBe(true);
    const sourceSheetId = created.ok ? created.output.id : "";
    const summaryTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";
    const notesTabId = created.ok ? (created.output.tabs[1]?.id ?? "") : "";

    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: summaryTabId,
        edits: [
          { row: 0, col: 0, value: "Customer" },
          { row: 0, col: 1, value: "ARR" },
          { row: 1, col: 0, value: "Acme" },
          {
            row: 1,
            col: 1,
            value: "1200",
            format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
          },
          { row: 2, col: 0, value: "Zenith" },
          { row: 2, col: 1, value: "800" },
          { row: 3, col: 1, value: "=SUM(B2:B3)" },
        ],
      },
      { actor },
    );
    await registry.invoke(
      "sheets.cells.update",
      {
        tabId: notesTabId,
        edits: [{ row: 0, col: 0, value: "Launch notes" }],
      },
      { actor },
    );

    const xlsx = await registry.invoke<{
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId: sourceSheetId, format: "xlsx" }, { actor: readerActor() });
    expect(xlsx.ok).toBe(true);
    expect(xlsx.ok ? xlsx.output.metadata : {}).toMatchObject({
      generatedBy: "helix.sheets.export.xlsx",
      sheetCount: 2,
      populatedCellCount: 8,
    });
    const xlsxImported = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string; readonly name: string }[];
      readonly import: Record<string, unknown>;
    }>(
      "sheets.import-xlsx",
      {
        filename: "Fidelity Roundtrip.xlsx",
        contentBase64: xlsx.ok ? xlsx.output.contentBase64 : "",
      },
      { actor },
    );
    expect(xlsxImported.ok).toBe(true);
    expect(xlsxImported.ok ? xlsxImported.output.tabs.map((tab) => tab.name) : []).toEqual([
      "Summary",
      "Notes",
    ]);
    expect(xlsxImported.ok ? xlsxImported.output.import : {}).toMatchObject({
      format: "xlsx",
      sheetCount: 2,
      populatedCellCount: 8,
    });
    await expectImportedWorkbookCells({
      registry,
      tabId: xlsxImported.ok ? (xlsxImported.output.tabs[0]?.id ?? "") : "",
      expectedFormattedCell: {
        row: 1,
        col: 1,
        value: "1200",
        format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
      },
    });

    const ods = await registry.invoke<{
      readonly contentBase64: string;
      readonly metadata: Record<string, unknown>;
    }>("sheets.export", { sheetId: sourceSheetId, format: "ods" }, { actor: readerActor() });
    expect(ods.ok).toBe(true);
    expect(ods.ok ? ods.output.metadata : {}).toMatchObject({
      generatedBy: "helix.sheets.export.ods",
      sheetCount: 2,
      populatedCellCount: 8,
    });
    const odsImported = await registry.invoke<{
      readonly tabs: { readonly id: string; readonly name: string }[];
      readonly import: Record<string, unknown>;
    }>(
      "sheets.import-ods",
      {
        filename: "Fidelity Roundtrip.ods",
        contentBase64: ods.ok ? ods.output.contentBase64 : "",
      },
      { actor },
    );
    expect(odsImported.ok).toBe(true);
    expect(odsImported.ok ? odsImported.output.tabs.map((tab) => tab.name) : []).toEqual([
      "Summary",
      "Notes",
    ]);
    expect(odsImported.ok ? odsImported.output.import : {}).toMatchObject({
      format: "ods",
      sheetCount: 2,
      populatedCellCount: 8,
    });
    await expectImportedWorkbookCells({
      registry,
      tabId: odsImported.ok ? (odsImported.output.tabs[0]?.id ?? "") : "",
    });
  });
});

async function expectImportedWorkbookCells(input: {
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly tabId: string;
  readonly expectedFormattedCell?: {
    readonly row: number;
    readonly col: number;
    readonly value: string;
    readonly format: Record<string, unknown>;
  };
}): Promise<void> {
  const tab = await input.registry.invoke<{
    readonly cells: Array<{
      readonly row: number;
      readonly col: number;
      readonly value: string;
      readonly formula: string | null;
      readonly calcValue: string | null;
      readonly format: Record<string, unknown>;
    }>;
  }>("sheets.tab.get", { tabId: input.tabId }, { actor: readerActor() });
  expect(tab.ok).toBe(true);
  const cells = tab.ok ? tab.output.cells : [];
  expect(cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, col: 0, value: "Customer" }),
      expect.objectContaining({ row: 1, col: 0, value: "Acme" }),
      expect.objectContaining({ row: 2, col: 1, value: "800" }),
      expect.objectContaining({
        row: 3,
        col: 1,
        value: "=SUM(B2:B3)",
        formula: "SUM(B2:B3)",
        calcValue: "2000",
      }),
    ]),
  );
  if (input.expectedFormattedCell !== undefined) {
    expect(cells).toEqual(
      expect.arrayContaining([expect.objectContaining(input.expectedFormattedCell)]),
    );
  }
}
