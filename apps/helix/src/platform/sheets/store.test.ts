import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../test/live-suite.js";
import {
  InMemorySheetsStore,
  PostgresSheetsStore,
  SheetsNotFoundError,
  SheetsValidationError,
  type SheetSnapshotStorageClient,
  type SheetSnapshotStorageResolver,
} from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherActorId = "33333333-3333-4333-8333-333333333333";

describe("InMemorySheetsStore", () => {
  it("creates a sheet with a default tab", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Renewals" });

    expect(sheet.title).toBe("Renewals");
    expect(sheet.ownerActorId).toBe(actorId);
    expect(sheet.deletedAt).toBeNull();
    expect(sheet.tabs).toHaveLength(1);
    expect(sheet.tabs[0]?.name).toBe("Sheet1");
    expect(sheet.tabs[0]?.position).toBe(0);
  });

  it("creates a sheet with named tabs in order", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({
      orgId,
      actorId,
      title: "Pipeline",
      tabNames: ["Customers", "Pipeline", "Lost"],
    });

    expect(sheet.tabs.map((tab) => tab.name)).toEqual(["Customers", "Pipeline", "Lost"]);
    expect(sheet.tabs.map((tab) => tab.position)).toEqual([0, 1, 2]);
  });

  it("rejects empty and overlong titles", async () => {
    const store = new InMemorySheetsStore();
    await expect(store.createSheet({ orgId, actorId, title: "   " })).rejects.toBeInstanceOf(
      SheetsValidationError,
    );
    await expect(
      store.createSheet({ orgId, actorId, title: "x".repeat(256) }),
    ).rejects.toBeInstanceOf(SheetsValidationError);
  });

  it("lists only sheets visible to the actor with pagination and search", async () => {
    const store = new InMemorySheetsStore();
    await store.createSheet({ orgId, actorId, title: "Alpha report" });
    await store.createSheet({ orgId, actorId, title: "Beta report" });
    await store.createSheet({ orgId, actorId: otherActorId, title: "Gamma" });

    const all = await store.listSheets({ orgId, actorId, limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.sheets).toHaveLength(2);

    const searched = await store.listSheets({
      orgId,
      actorId,
      query: "beta",
      limit: 50,
      offset: 0,
    });
    expect(searched.total).toBe(1);
    expect(searched.sheets[0]?.title).toBe("Beta report");

    const paged = await store.listSheets({ orgId, actorId, limit: 1, offset: 1 });
    expect(paged.total).toBe(2);
    expect(paged.sheets).toHaveLength(1);
  });

  it("hides another actor's sheet from get/update/delete", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Private" });

    expect(await store.getSheet({ orgId, actorId: otherActorId, sheetId: sheet.id })).toBeNull();
    expect(
      await store.updateSheet({
        orgId,
        actorId: otherActorId,
        sheetId: sheet.id,
        title: "Hijacked",
      }),
    ).toBeNull();
    expect(await store.deleteSheet({ orgId, actorId: otherActorId, sheetId: sheet.id })).toBeNull();
  });

  it("soft-deletes a sheet so it no longer lists", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Temp" });

    const deleted = await store.deleteSheet({ orgId, actorId, sheetId: sheet.id });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    const list = await store.listSheets({ orgId, actorId, limit: 50, offset: 0 });
    expect(list.total).toBe(0);
    expect(await store.getSheet({ orgId, actorId, sheetId: sheet.id })).toBeNull();
  });

  it("creates, updates, and reorders tabs", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Book" });

    const tab = await store.createTab({ orgId, actorId, sheetId: sheet.id, name: "Q3" });
    expect(tab.position).toBe(1);

    const updated = await store.updateTab({
      orgId,
      actorId,
      tabId: tab.id,
      name: "Q4",
      position: 0,
    });
    expect(updated?.name).toBe("Q4");
    expect(updated?.position).toBe(0);
  });

  it("refuses to delete the last remaining tab", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Single" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await expect(store.deleteTab({ orgId, actorId, tabId })).rejects.toBeInstanceOf(
      SheetsValidationError,
    );
  });

  it("deletes a non-last tab and drops its cells", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Book", tabNames: ["A", "B"] });
    const tabB = sheet.tabs[1];
    if (tabB === undefined) {
      throw new Error("expected two tabs");
    }
    await store.updateCells({
      orgId,
      actorId,
      tabId: tabB.id,
      edits: [{ row: 0, col: 0, value: "x" }],
    });

    const deleted = await store.deleteTab({ orgId, actorId, tabId: tabB.id });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(await store.getTabCells({ orgId, actorId, tabId: tabB.id })).toBeNull();
  });

  it("persists sheet operation log records with monotonically increasing revisions", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Collaborative" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }

    const first = await store.appendOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operationId: "op-1",
      baseRevision: 0,
      operation: { id: "op-1", baseRevision: 0, changes: [] },
    });
    const second = await store.appendOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operationId: "op-2",
      baseRevision: 1,
      operation: { id: "op-2", baseRevision: 1, changes: [] },
    });
    const duplicate = await store.appendOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operationId: "op-1",
      baseRevision: 0,
      operation: { id: "op-1", baseRevision: 0, changes: [] },
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(duplicate).toEqual(first);
    await expect(store.listOperations({ orgId, actorId, sheetId: sheet.id })).resolves.toEqual([
      first,
      second,
    ]);
  });

  it("compacts sheet operation logs while preserving revision numbering", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Compactable" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }

    await store.appendOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operationId: "op-1",
      baseRevision: 0,
      operation: { id: "op-1", baseRevision: 0, changes: [] },
    });
    const second = await store.appendOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operationId: "op-2",
      baseRevision: 1,
      operation: { id: "op-2", baseRevision: 1, changes: [] },
    });

    await expect(
      store.compactOperations({ orgId, actorId, sheetId: sheet.id, retainRevisions: 1 }),
    ).resolves.toEqual({
      latestRevision: 2,
      compactedThroughRevision: 1,
      deletedCount: 1,
    });
    await expect(store.listOperations({ orgId, actorId, sheetId: sheet.id })).resolves.toEqual([
      second,
    ]);
    await expect(
      store.appendOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId: tab.id,
        operationId: "op-3",
        baseRevision: 2,
        operation: { id: "op-3", baseRevision: 2, changes: [] },
      }),
    ).resolves.toMatchObject({ revision: 3 });
    await expect(
      store.applyOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId: tab.id,
        operation: {
          id: "op-too-old",
          baseRevision: 0,
          changes: [{ kind: "set-cell", row: 0, col: 0, value: "stale" }],
        },
      }),
    ).resolves.toEqual({
      status: "compacted",
      operationId: "op-too-old",
      revision: 3,
      compactedThroughRevision: 1,
    });
  });

  it("applies sheet operations through the durable revision path", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Collaborative" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }

    const applied = await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: {
        id: "op-a",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "higher" }],
      },
    });
    const duplicate = await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: {
        id: "op-a",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "ignored" }],
      },
    });
    const ahead = await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: {
        id: "op-z",
        baseRevision: 10,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "ahead" }],
      },
    });

    expect(applied).toMatchObject({
      status: "applied",
      revision: 1,
      operation: { id: "op-a", baseRevision: 0 },
    });
    expect(duplicate).toEqual({ status: "duplicate", operationId: "op-a", revision: 1 });
    expect(ahead).toEqual({ status: "ahead", operationId: "op-z", revision: 1 });
    await expect(store.getTabCells({ orgId, actorId, tabId: tab.id })).resolves.toMatchObject({
      cells: [expect.objectContaining({ row: 0, col: 0, value: "higher" })],
    });
  });

  it("applies structural row and column operations through the durable revision path", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Structure" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    await store.updateCells({
      orgId,
      actorId,
      tabId: tab.id,
      edits: [
        { row: 0, col: 0, value: "A1" },
        { row: 1, col: 1, value: "B2" },
        { row: 2, col: 2, value: "C3" },
      ],
    });

    const applied = await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: {
        id: "op-structure",
        baseRevision: 0,
        changes: [
          { kind: "insert-rows", index: 1, count: 1 },
          { kind: "delete-columns", index: 0, count: 1 },
        ],
      },
    });

    expect(applied).toMatchObject({
      status: "applied",
      revision: 1,
      operation: { id: "op-structure" },
    });
    await expect(store.getTabCells({ orgId, actorId, tabId: tab.id })).resolves.toMatchObject({
      cells: [
        expect.objectContaining({ row: 2, col: 0, value: "B2" }),
        expect.objectContaining({ row: 3, col: 1, value: "C3" }),
      ],
    });
  });

  it("returns bounded cell windows for tab reads and cell writes", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Windowed Cells" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    await store.updateCells({
      orgId,
      actorId,
      tabId: tab.id,
      edits: [
        { row: 0, col: 0, value: "A1" },
        { row: 3, col: 2, value: "C4" },
        { row: 10, col: 10, value: "K11" },
      ],
    });

    await expect(
      store.getTabCells({
        orgId,
        actorId,
        tabId: tab.id,
        window: { startRow: 2, startCol: 1, endRow: 4, endCol: 3 },
      }),
    ).resolves.toMatchObject({
      cells: [expect.objectContaining({ row: 3, col: 2, value: "C4" })],
    });

    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId: tab.id,
        edits: [
          { row: 3, col: 2, value: "updated" },
          { row: 12, col: 12, value: "M13" },
        ],
        window: { startRow: 3, startCol: 2, endRow: 3, endCol: 2 },
      }),
    ).resolves.toMatchObject({
      cells: [expect.objectContaining({ row: 3, col: 2, value: "updated" })],
    });
  });

  it("rebases formula references when applying durable structural operations", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Formula Structure" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    await store.updateCells({
      orgId,
      actorId,
      tabId: tab.id,
      edits: [
        { row: 0, col: 0, value: "10" },
        { row: 0, col: 1, value: "5" },
        { row: 2, col: 2, value: "=A1+$A$1+B$1+$B1" },
      ],
    });

    const applied = await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: {
        id: "op-structure-formula",
        baseRevision: 0,
        changes: [
          { kind: "insert-rows", index: 0, count: 1 },
          { kind: "insert-columns", index: 0, count: 1 },
        ],
      },
    });

    expect(applied).toMatchObject({ status: "applied", revision: 1 });
    const tabCells = await store.getTabCells({ orgId, actorId, tabId: tab.id });
    if (tabCells === null) {
      throw new Error("expected tab cells after applying structural operation");
    }
    const cells = tabCells.cells.map((cell) => ({
      row: cell.row,
      col: cell.col,
      value: cell.value,
      formula: cell.formula,
      calcValue: cell.calcValue,
      dependencies: cell.dependencies,
      formulaError: cell.formulaError,
    }));
    expect(cells).toContainEqual({
      row: 1,
      col: 1,
      value: "10",
      formula: null,
      calcValue: "10",
      dependencies: [],
      formulaError: null,
    });
    expect(cells).toContainEqual({
      row: 1,
      col: 2,
      value: "5",
      formula: null,
      calcValue: "5",
      dependencies: [],
      formulaError: null,
    });
    expect(cells).toContainEqual({
      row: 3,
      col: 3,
      value: "=B2+$B$2+C$2+$C2",
      formula: "B2+$B$2+C$2+$C2",
      calcValue: "30",
      dependencies: ["B2", "C2"],
      formulaError: null,
    });
  });

  it("applies batch cell edits and clears empty cells", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const written = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 0, col: 0, value: "Customer" },
        { row: 0, col: 1, value: "ARR" },
        { row: 1, col: 0, value: "Atlas", format: { bold: true } },
      ],
    });
    expect(written.cells).toHaveLength(3);
    expect(written.cells.find((cell) => cell.row === 1)?.format).toEqual({ bold: true });

    const cleared = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "" }],
    });
    expect(cleared.cells).toHaveLength(2);
    expect(cleared.cells.some((cell) => cell.row === 0 && cell.col === 0)).toBe(false);
  });

  it("preserves format when an edit omits it", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "A", format: { bold: true } }],
    });
    const result = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "B" }],
    });
    expect(result.cells[0]?.value).toBe("B");
    expect(result.cells[0]?.format).toEqual({ bold: true });
  });

  it("rejects edits inside sheet metadata protected ranges", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        protectedRanges: [
          {
            id: "protected-1",
            tabId,
            label: "Locked ARR",
            range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
          },
        ],
      },
    });

    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId,
        edits: [{ row: 1, col: 1, value: "blocked" }],
      }),
    ).rejects.toThrow("Locked ARR");

    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId,
        edits: [{ row: 0, col: 0, value: "allowed" }],
      }),
    ).resolves.toMatchObject({
      cells: [expect.objectContaining({ row: 0, col: 0, value: "allowed" })],
    });
  });

  it("allows warning-only protected ranges while blocking explicit block ranges", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        protectedRanges: [
          {
            id: "protected-warn",
            tabId,
            label: "Warning ARR",
            mode: "warn",
            range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
          },
          {
            id: "protected-block",
            tabId,
            label: "Locked ARR",
            mode: "block",
            range: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 },
          },
        ],
      },
    });

    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId,
        edits: [{ row: 1, col: 1, value: "warned" }],
      }),
    ).resolves.toMatchObject({
      cells: [expect.objectContaining({ row: 1, col: 1, value: "warned" })],
    });

    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId,
        edits: [{ row: 2, col: 1, value: "blocked" }],
      }),
    ).rejects.toThrow("Locked ARR");
  });

  it("applies warning-only protected ranges to durable operations without bypassing block ranges", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Collaborative" });
    const tabId = sheet.tabs[0]?.id ?? "";
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        protectedRanges: [
          {
            id: "protected-warn",
            tabId,
            label: "Warning ARR",
            mode: "warn",
            range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
          },
          {
            id: "protected-block",
            tabId,
            label: "Locked ARR",
            range: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 },
          },
        ],
      },
    });

    await expect(
      store.applyOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId,
        operation: {
          id: "op-warn",
          baseRevision: 0,
          changes: [{ kind: "set-cell", row: 1, col: 1, value: "warned" }],
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });

    await expect(
      store.applyOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId,
        operation: {
          id: "op-block",
          baseRevision: 1,
          changes: [{ kind: "set-cell", row: 2, col: 1, value: "blocked" }],
        },
      }),
    ).rejects.toThrow("Locked ARR");
  });

  it("round-trips formatting metadata through cell updates", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const written = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        {
          row: 0,
          col: 0,
          value: "not-a-number",
          format: { dataValidation: { type: "number" } },
        },
        {
          row: 1,
          col: 0,
          value: "",
          format: { dataValidation: { type: "email" } },
        },
        {
          row: 1,
          col: 2,
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
      ],
    });

    expect(written.cells.find((cell) => cell.row === 0)?.format).toEqual({
      dataValidation: { type: "number" },
    });
    expect(written.cells.find((cell) => cell.row === 1)?.format).toEqual({
      dataValidation: { type: "email" },
    });
    expect(written.cells.find((cell) => cell.row === 1 && cell.col === 2)?.format).toEqual({
      dataValidation: { type: "list", choices: ["Approved", "Pending"] },
    });
    expect(written.cells.find((cell) => cell.row === 1 && cell.col === 1)?.format).toEqual({
      numberFormat: "date",
      conditionalFormat: {
        type: "greaterThan100",
        operator: "greaterThan",
        value: 100,
        fillColor: "#dcfce7",
        textColor: "#166534",
      },
    });
    expect(written.cells.find((cell) => cell.row === 2 && cell.col === 0)?.format).toEqual({
      numberFormat: "custom",
      customNumberFormat: "#,##0.00",
    });

    const valueOnlyEdit = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "123" }],
    });

    expect(valueOnlyEdit.cells.find((cell) => cell.row === 0)).toMatchObject({
      value: "123",
      format: { dataValidation: { type: "number" } },
    });
  });

  it("persists selected-range comments against a spreadsheet", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const comment = await store.createComment({
      orgId,
      actorId,
      sheetId: sheet.id,
      body: "Check renewal math",
      anchor: {
        type: "sheet-range",
        tabId,
        label: "B2:C2",
        range: { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
      },
      metadata: { source: "test" },
    });

    expect(comment).toMatchObject({
      sheetId: sheet.id,
      body: "Check renewal math",
      status: "open",
      anchor: { type: "sheet-range", label: "B2:C2" },
      metadata: { source: "test" },
    });

    await store.createComment({
      orgId,
      actorId,
      sheetId: sheet.id,
      parentCommentId: comment.id,
      body: "Reply",
      anchor: comment.anchor,
    });

    const listed = await store.listComments({
      orgId,
      actorId,
      sheetId: sheet.id,
      status: "open",
    });
    expect(listed).toHaveLength(2);
    expect(listed[0]?.author?.id).toBe(actorId);

    const resolved = await store.resolveComment({ orgId, actorId, commentId: comment.id });
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);

    const open = await store.listComments({ orgId, actorId, sheetId: sheet.id, status: "open" });
    expect(open.map((item) => item.body)).toEqual(["Reply"]);

    const reopened = await store.reopenComment({ orgId, actorId, commentId: comment.id });
    expect(reopened).toMatchObject({ id: comment.id, status: "open", resolvedAt: null });

    const updated = await store.updateComment({
      orgId,
      actorId,
      commentId: comment.id,
      body: "Check renewal math before close",
    });
    expect(updated).toMatchObject({ id: comment.id, body: "Check renewal math before close" });
    expect(updated?.updatedAt).toBeInstanceOf(Date);

    const deleted = await store.deleteComment({ orgId, actorId, commentId: comment.id });
    expect(deleted?.id).toBe(comment.id);

    const all = await store.listComments({ orgId, actorId, sheetId: sheet.id, status: "all" });
    expect(all.map((item) => item.id)).not.toContain(comment.id);
    expect(all.map((item) => item.body)).toEqual([]);
  });

  it("persists and refreshes formula metadata for dependent cells", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const written = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 0, col: 0, value: "10" },
        { row: 1, col: 0, value: "20" },
        { row: 2, col: 0, value: "=SUM(A1:A2)" },
        { row: 3, col: 0, value: "=AVERAGE(A1:A2)" },
        { row: 4, col: 0, value: "=COUNT(A1:A2)" },
      ],
    });
    expect(written.cells.find((cell) => cell.row === 2)).toMatchObject({
      formula: "SUM(A1:A2)",
      calcValue: "30",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    expect(written.cells.find((cell) => cell.row === 3)).toMatchObject({
      formula: "AVERAGE(A1:A2)",
      calcValue: "15",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    expect(written.cells.find((cell) => cell.row === 4)).toMatchObject({
      formula: "COUNT(A1:A2)",
      calcValue: "2",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });

    const recalculated = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 1, col: 0, value: "25" }],
    });
    expect(recalculated.cells.find((cell) => cell.row === 2)).toMatchObject({
      formula: "SUM(A1:A2)",
      calcValue: "35",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
    expect(recalculated.cells.find((cell) => cell.row === 3)).toMatchObject({
      formula: "AVERAGE(A1:A2)",
      calcValue: "17.5",
      dependencies: ["A1", "A2"],
      formulaError: null,
    });
  });

  it("persists and refreshes formulas that reference metadata named ranges", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Named Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        namedRanges: [
          {
            id: "named-1",
            tabId,
            name: "Revenue_Table",
            range: { startRow: 1, startCol: 1, endRow: 2, endCol: 1 },
          },
        ],
      },
    });

    const written = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 1, col: 1, value: "100" },
        { row: 2, col: 1, value: "150" },
        { row: 3, col: 1, value: "=SUM(Revenue_Table)" },
        { row: 4, col: 1, value: "=MAX(Revenue_Table)" },
      ],
    });
    expect(written.cells.find((cell) => cell.row === 3 && cell.col === 1)).toMatchObject({
      formula: "SUM(Revenue_Table)",
      calcValue: "250",
      dependencies: ["B2", "B3"],
      formulaError: null,
    });
    expect(written.cells.find((cell) => cell.row === 4 && cell.col === 1)).toMatchObject({
      formula: "MAX(Revenue_Table)",
      calcValue: "150",
      dependencies: ["B2", "B3"],
      formulaError: null,
    });

    const recalculated = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 2, col: 1, value: "175" }],
    });
    expect(recalculated.cells.find((cell) => cell.row === 3 && cell.col === 1)).toMatchObject({
      calcValue: "275",
      formulaError: null,
    });
    expect(recalculated.cells.find((cell) => cell.row === 4 && cell.col === 1)).toMatchObject({
      calcValue: "175",
      formulaError: null,
    });
  });

  it("refreshes formulas that reference cells and named ranges on other tabs", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Workbook Model" });
    const modelTabId = sheet.tabs[0]?.id ?? "";
    const summary = await store.createTab({ orgId, actorId, sheetId: sheet.id, name: "Summary" });
    const fy2026 = await store.createTab({ orgId, actorId, sheetId: sheet.id, name: "FY 2026" });
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        namedRanges: [
          {
            id: "named-revenue",
            tabId: fy2026.id,
            name: "Revenue_Table",
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
          },
        ],
      },
    });

    await store.updateCells({
      orgId,
      actorId,
      tabId: summary.id,
      edits: [{ row: 0, col: 1, value: "125" }],
    });
    await store.updateCells({
      orgId,
      actorId,
      tabId: fy2026.id,
      edits: [
        { row: 0, col: 0, value: "10" },
        { row: 1, col: 0, value: "20" },
      ],
    });

    const model = await store.updateCells({
      orgId,
      actorId,
      tabId: modelTabId,
      edits: [
        { row: 0, col: 0, value: "=Summary!B1*2" },
        { row: 1, col: 0, value: "=SUM('FY 2026'!A1:A2)" },
        { row: 2, col: 0, value: "=MAX(Revenue_Table)" },
      ],
    });

    expect(model.cells.find((cell) => cell.row === 0 && cell.col === 0)).toMatchObject({
      calcValue: "250",
      dependencies: ["Summary!B1"],
      formulaError: null,
    });
    expect(model.cells.find((cell) => cell.row === 1 && cell.col === 0)).toMatchObject({
      calcValue: "30",
      dependencies: ["'FY 2026'!A1", "'FY 2026'!A2"],
      formulaError: null,
    });
    expect(model.cells.find((cell) => cell.row === 2 && cell.col === 0)).toMatchObject({
      calcValue: "20",
      dependencies: ["'FY 2026'!A1", "'FY 2026'!A2"],
      formulaError: null,
    });

    await store.updateCells({
      orgId,
      actorId,
      tabId: fy2026.id,
      edits: [{ row: 1, col: 0, value: "40" }],
    });
    const recalculated = await store.getTabCells({ orgId, actorId, tabId: modelTabId });

    expect(recalculated?.cells.find((cell) => cell.row === 1 && cell.col === 0)).toMatchObject({
      calcValue: "50",
      formulaError: null,
    });
    expect(recalculated?.cells.find((cell) => cell.row === 2 && cell.col === 0)).toMatchObject({
      calcValue: "40",
      formulaError: null,
    });

    await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: modelTabId,
      operation: {
        id: "insert-model-row",
        baseRevision: 0,
        changes: [{ kind: "insert-rows", index: 0, count: 1 }],
      },
    });
    const shifted = await store.getTabCells({ orgId, actorId, tabId: modelTabId });

    expect(shifted?.cells.find((cell) => cell.row === 1 && cell.col === 0)).toMatchObject({
      value: "=Summary!B1*2",
      calcValue: "250",
      dependencies: ["Summary!B1"],
      formulaError: null,
    });
    expect(shifted?.cells.find((cell) => cell.row === 2 && cell.col === 0)).toMatchObject({
      value: "=SUM('FY 2026'!A1:A2)",
      calcValue: "50",
      dependencies: ["'FY 2026'!A1", "'FY 2026'!A2"],
      formulaError: null,
    });
  });

  it("sorts selected ranges server-side while moving formats and rebasing relative formulas", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Sort Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";
    await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 1, col: 0, value: "Zeta", format: { fillColor: "#fef3c7" } },
        { row: 1, col: 1, value: "=A2", format: { fillColor: "#fef3c7" } },
        { row: 2, col: 0, value: "Alpha" },
        { row: 2, col: 1, value: "=$A$3+A3" },
      ],
    });

    const sorted = await store.sortRange({
      orgId,
      actorId,
      tabId,
      range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
      direction: "asc",
    });

    expect(sorted.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 1, col: 0, value: "Alpha", format: {} }),
        expect.objectContaining({
          row: 1,
          col: 1,
          value: "=$A$3+A2",
          formula: "$A$3+A2",
          format: {},
        }),
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
          formula: "A3",
          format: { fillColor: "#fef3c7" },
        }),
      ]),
    );
  });

  it("rejects server-side range sorts that intersect blocked protected ranges", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Locked Sort" });
    const tabId = sheet.tabs[0]?.id ?? "";
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        protectedRanges: [
          {
            tabId,
            label: "Locked range",
            range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
          },
        ],
      },
    });
    await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 0, col: 0, value: "allowed" },
        { row: 3, col: 0, value: "also allowed" },
      ],
    });

    await expect(
      store.sortRange({
        orgId,
        actorId,
        tabId,
        range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
        direction: "asc",
      }),
    ).rejects.toThrow("Locked range");
  });

  it("rebases metadata ranges during durable structural operations", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Named Range Structure" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        namedRanges: [
          {
            id: "named-revenue",
            tabId: tab.id,
            name: "Revenue_Table",
            range: { startRow: 1, startCol: 1, endRow: 2, endCol: 1 },
          },
          {
            id: "named-obsolete",
            tabId: tab.id,
            name: "Obsolete",
            range: { startRow: 5, startCol: 1, endRow: 5, endCol: 2 },
          },
          {
            id: "named-partial",
            tabId: tab.id,
            name: "Partial_Window",
            range: { startRow: 4, startCol: 0, endRow: 6, endCol: 0 },
          },
        ],
        mergedCells: [
          {
            id: "merge-revenue",
            tabId: tab.id,
            label: "Revenue header",
            range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
          },
          {
            id: "merge-obsolete",
            tabId: tab.id,
            label: "Obsolete merge",
            range: { startRow: 5, startCol: 0, endRow: 5, endCol: 1 },
          },
        ],
        protectedRanges: [
          {
            id: "protected-revenue",
            tabId: tab.id,
            label: "Locked Revenue",
            mode: "block",
            range: { startRow: 1, startCol: 3, endRow: 2, endCol: 4 },
          },
          {
            id: "protected-obsolete",
            tabId: tab.id,
            label: "Obsolete Lock",
            range: { startRow: 5, startCol: 3, endRow: 5, endCol: 3 },
          },
        ],
        charts: [
          {
            id: "chart-revenue",
            tabId: tab.id,
            type: "bar",
            title: "Revenue chart",
            range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
            placement: { anchorRow: 2, anchorCol: 5, rowSpan: 8, colSpan: 4 },
          },
          {
            id: "chart-obsolete",
            tabId: tab.id,
            type: "line",
            title: "Obsolete chart",
            range: { startRow: 5, startCol: 0, endRow: 5, endCol: 1 },
          },
        ],
        filterViews: [
          {
            id: "filter-revenue",
            tabId: tab.id,
            name: "Revenue filter",
            sortDirection: "asc",
            sortColumn: 1,
            sortKeys: [0, 1],
            predicate: { column: 1, operator: "contains", value: "1" },
            predicates: [{ column: 1, operator: "contains", value: "1" }],
            range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
          },
          {
            id: "filter-obsolete",
            tabId: tab.id,
            name: "Obsolete filter",
            sortDirection: "desc",
            range: { startRow: 5, startCol: 0, endRow: 5, endCol: 1 },
          },
        ],
        pivotTables: [
          {
            id: "pivot-revenue",
            tabId: tab.id,
            title: "Revenue pivot",
            rowFieldCol: 0,
            valueFieldCol: 1,
            aggregation: "sum",
            slicer: { column: 1, operator: "contains", value: "1" },
            range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
          },
          {
            id: "pivot-obsolete",
            tabId: tab.id,
            title: "Obsolete pivot",
            rowFieldCol: 0,
            valueFieldCol: 1,
            aggregation: "count",
            range: { startRow: 5, startCol: 0, endRow: 5, endCol: 1 },
          },
        ],
      },
    });
    const revenueComment = await store.createComment({
      orgId,
      actorId,
      sheetId: sheet.id,
      body: "Review revenue range",
      anchor: {
        type: "sheet-range",
        tabId: tab.id,
        label: "B2:B3",
        range: { startRow: 1, startCol: 1, endRow: 2, endCol: 1 },
      },
    });
    const obsoleteComment = await store.createComment({
      orgId,
      actorId,
      sheetId: sheet.id,
      body: "Review deleted row",
      anchor: {
        type: "sheet-range",
        tabId: tab.id,
        label: "A6",
        range: { startRow: 5, startCol: 0, endRow: 5, endCol: 0 },
      },
    });
    await store.updateCells({
      orgId,
      actorId,
      tabId: tab.id,
      edits: [
        { row: 1, col: 1, value: "100" },
        { row: 2, col: 1, value: "150" },
        { row: 3, col: 1, value: "=SUM(Revenue_Table)" },
        { row: 5, col: 1, value: "stale" },
      ],
    });

    const applied = await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: {
        id: "op-named-range-structure",
        baseRevision: 0,
        changes: [
          { kind: "insert-rows", index: 2, count: 1 },
          { kind: "insert-columns", index: 1, count: 1 },
          { kind: "delete-rows", index: 6, count: 1 },
        ],
      },
    });

    expect(applied).toMatchObject({ status: "applied", revision: 1 });
    const updatedSheet = await store.getSheet({ orgId, actorId, sheetId: sheet.id });
    expect(updatedSheet?.metadata["namedRanges"]).toEqual([
      {
        id: "named-revenue",
        tabId: tab.id,
        name: "Revenue_Table",
        range: { startRow: 1, startCol: 2, endRow: 3, endCol: 2 },
      },
      {
        id: "named-partial",
        tabId: tab.id,
        name: "Partial_Window",
        range: { startRow: 5, startCol: 0, endRow: 6, endCol: 0 },
      },
    ]);
    expect(updatedSheet?.metadata["mergedCells"]).toEqual([
      {
        id: "merge-revenue",
        tabId: tab.id,
        label: "Revenue header",
        range: { startRow: 1, startCol: 2, endRow: 3, endCol: 3 },
      },
    ]);
    expect(updatedSheet?.metadata["protectedRanges"]).toEqual([
      {
        id: "protected-revenue",
        tabId: tab.id,
        label: "Locked Revenue",
        mode: "block",
        range: { startRow: 1, startCol: 4, endRow: 3, endCol: 5 },
      },
    ]);
    expect(updatedSheet?.metadata["charts"]).toEqual([
      {
        id: "chart-revenue",
        tabId: tab.id,
        type: "bar",
        title: "Revenue chart",
        range: { startRow: 1, startCol: 0, endRow: 3, endCol: 2 },
        placement: { anchorRow: 3, anchorCol: 6, rowSpan: 8, colSpan: 4 },
      },
    ]);
    expect(updatedSheet?.metadata["filterViews"]).toEqual([
      {
        id: "filter-revenue",
        tabId: tab.id,
        name: "Revenue filter",
        sortDirection: "asc",
        sortColumn: 2,
        sortKeys: [0, 2],
        predicate: { column: 2, operator: "contains", value: "1" },
        predicates: [{ column: 2, operator: "contains", value: "1" }],
        range: { startRow: 1, startCol: 0, endRow: 3, endCol: 2 },
      },
    ]);
    expect(updatedSheet?.metadata["pivotTables"]).toEqual([
      {
        id: "pivot-revenue",
        tabId: tab.id,
        title: "Revenue pivot",
        rowFieldCol: 0,
        valueFieldCol: 2,
        aggregation: "sum",
        slicer: { column: 2, operator: "contains", value: "1" },
        range: { startRow: 1, startCol: 0, endRow: 3, endCol: 2 },
      },
    ]);
    const comments = await store.listComments({ orgId, actorId, sheetId: sheet.id, status: "all" });
    expect(comments.find((comment) => comment.id === revenueComment.id)?.anchor).toEqual({
      type: "sheet-range",
      tabId: tab.id,
      label: "C2:C4",
      range: { startRow: 1, startCol: 2, endRow: 3, endCol: 2 },
      deleted: false,
    });
    expect(comments.find((comment) => comment.id === obsoleteComment.id)?.anchor).toEqual({
      type: "sheet-range",
      tabId: tab.id,
      label: "Deleted range",
      deleted: true,
    });
    const tabCells = await store.getTabCells({ orgId, actorId, tabId: tab.id });
    expect(tabCells?.cells.find((cell) => cell.row === 4 && cell.col === 2)).toMatchObject({
      value: "=SUM(Revenue_Table)",
      formula: "SUM(Revenue_Table)",
      calcValue: "250",
      dependencies: ["C2", "C3", "C4"],
      formulaError: null,
    });
  });

  it("rebases metadata frozen panes during durable structural operations", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Frozen Pane Structure" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        retained: { value: "keep-me" },
        frozenPanes: [
          { tabId: tab.id, frozenRows: 2, frozenCols: 3, label: "main" },
          { tabId: tab.id, frozenRows: 1, frozenCols: 1, label: "clamp" },
          { tabId: "other-tab", frozenRows: 4, frozenCols: 5, label: "other" },
          { tabId: tab.id, frozenRows: "bad", frozenCols: 2, label: "invalid" },
        ],
      },
    });

    await expect(
      store.applyOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId: tab.id,
        operation: {
          id: "op-frozen-pane-structure",
          baseRevision: 0,
          changes: [
            { kind: "insert-rows", index: 1, count: 2 },
            { kind: "insert-columns", index: 2, count: 1 },
            { kind: "delete-rows", index: 0, count: 3 },
            { kind: "delete-columns", index: 0, count: 3 },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });

    const updatedSheet = await store.getSheet({ orgId, actorId, sheetId: sheet.id });
    expect(updatedSheet?.metadata["retained"]).toEqual({ value: "keep-me" });
    expect(updatedSheet?.metadata["frozenPanes"]).toEqual([
      { tabId: tab.id, frozenRows: 1, frozenCols: 1, label: "main" },
      { tabId: tab.id, frozenRows: 0, frozenCols: 0, label: "clamp" },
      { tabId: "other-tab", frozenRows: 4, frozenCols: 5, label: "other" },
      { tabId: tab.id, frozenRows: "bad", frozenCols: 2, label: "invalid" },
    ]);
  });

  it("rebases chart label and value columns on durable column inserts", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Chart Column Insert" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        charts: [
          {
            id: "chart-shift",
            tabId: tab.id,
            type: "bar",
            title: "Shifted chart",
            labelCol: 1,
            valueCol: 2,
            range: { startRow: 0, startCol: 1, endRow: 3, endCol: 2 },
          },
          {
            id: "chart-before",
            tabId: tab.id,
            type: "line",
            title: "Before insert",
            labelCol: 0,
            valueCol: 0,
            range: { startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
          },
        ],
      },
    });

    await expect(
      store.applyOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId: tab.id,
        operation: {
          id: "op-chart-column-insert",
          baseRevision: 0,
          changes: [{ kind: "insert-columns", index: 1, count: 2 }],
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });

    const updatedSheet = await store.getSheet({ orgId, actorId, sheetId: sheet.id });
    expect(updatedSheet?.metadata["charts"]).toEqual([
      {
        id: "chart-shift",
        tabId: tab.id,
        type: "bar",
        title: "Shifted chart",
        labelCol: 3,
        valueCol: 4,
        range: { startRow: 0, startCol: 3, endRow: 3, endCol: 4 },
      },
      {
        id: "chart-before",
        tabId: tab.id,
        type: "line",
        title: "Before insert",
        labelCol: 0,
        valueCol: 0,
        range: { startRow: 0, startCol: 0, endRow: 3, endCol: 0 },
      },
    ]);
  });

  it("removes deleted chart label and value columns while preserving invalid chart metadata", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Chart Column Delete" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("expected a default tab");
    }
    const invalidChart = {
      id: "chart-invalid",
      tabId: tab.id,
      type: "bar",
      title: "Invalid chart metadata",
      labelCol: -1,
      valueCol: "bad",
      range: { startRow: 0, startCol: 2, endRow: 3, endCol: 4 },
    };
    await store.updateSheet({
      orgId,
      actorId,
      sheetId: sheet.id,
      metadata: {
        charts: [
          {
            id: "chart-remove",
            tabId: tab.id,
            type: "bar",
            title: "Deleted value column",
            labelCol: 0,
            valueCol: 2,
            range: { startRow: 0, startCol: 0, endRow: 3, endCol: 3 },
          },
          {
            id: "chart-shift-left",
            tabId: tab.id,
            type: "line",
            title: "Shift left",
            labelCol: 4,
            valueCol: 5,
            range: { startRow: 0, startCol: 4, endRow: 3, endCol: 5 },
          },
          invalidChart,
        ],
      },
    });

    await expect(
      store.applyOperation({
        orgId,
        actorId,
        sheetId: sheet.id,
        tabId: tab.id,
        operation: {
          id: "op-chart-column-delete",
          baseRevision: 0,
          changes: [{ kind: "delete-columns", index: 1, count: 2 }],
        },
      }),
    ).resolves.toMatchObject({ status: "applied", revision: 1 });

    const updatedSheet = await store.getSheet({ orgId, actorId, sheetId: sheet.id });
    expect(updatedSheet?.metadata["charts"]).toEqual([
      {
        id: "chart-remove",
        tabId: tab.id,
        type: "bar",
        title: "Deleted value column",
        labelCol: 0,
        range: { startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
      },
      {
        id: "chart-shift-left",
        tabId: tab.id,
        type: "line",
        title: "Shift left",
        labelCol: 2,
        valueCol: 3,
        range: { startRow: 0, startCol: 2, endRow: 3, endCol: 3 },
      },
      invalidChart,
    ]);
  });

  it("persists and refreshes scalar QUERY formula metadata", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Query Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const written = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 0, col: 0, value: "Region" },
        { row: 0, col: 1, value: "ARR" },
        { row: 1, col: 0, value: "North" },
        { row: 1, col: 1, value: "10" },
        { row: 2, col: 0, value: "South" },
        { row: 2, col: 1, value: "20" },
        { row: 3, col: 0, value: "North" },
        { row: 3, col: 1, value: "30" },
        { row: 4, col: 0, value: "=QUERY(A1:B4, \"select sum(B) where A = 'North'\", 1)" },
      ],
    });
    expect(written.cells.find((cell) => cell.row === 4 && cell.col === 0)).toMatchObject({
      formula: "QUERY(A1:B4, \"select sum(B) where A = 'North'\", 1)",
      calcValue: "40",
      dependencies: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"],
      formulaError: null,
    });

    const recalculated = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 3, col: 1, value: "35" }],
    });
    expect(recalculated.cells.find((cell) => cell.row === 4 && cell.col === 0)).toMatchObject({
      calcValue: "45",
      formulaError: null,
    });
  });

  it("persists formula errors", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const result = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "=A1" }],
    });

    expect(result.cells[0]).toMatchObject({
      formula: "A1",
      calcValue: "#CIRC",
      dependencies: ["A1"],
      formulaError: "Circular reference",
    });
  });

  it("rejects negative coordinates and overlong cell values", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await expect(
      store.updateCells({ orgId, actorId, tabId, edits: [{ row: -1, col: 0, value: "x" }] }),
    ).rejects.toBeInstanceOf(SheetsValidationError);
    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId,
        edits: [{ row: 0, col: 0, value: "x".repeat(32_769) }],
      }),
    ).rejects.toBeInstanceOf(SheetsValidationError);
  });

  it("throws when updating cells on an inaccessible tab", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await expect(
      store.updateCells({
        orgId,
        actorId: otherActorId,
        tabId,
        edits: [{ row: 0, col: 0, value: "x" }],
      }),
    ).rejects.toBeInstanceOf(SheetsNotFoundError);
  });

  it("stores folderId and app in metadata when folderId is provided", async () => {
    const store = new InMemorySheetsStore();
    const folderId = "44444444-4444-4444-8444-444444444444";
    const sheet = await store.createSheet({
      orgId,
      actorId,
      title: "Folder Sheet",
      folderId,
    });

    expect((sheet.metadata as Record<string, unknown>)["folderId"]).toBe(folderId);
    expect((sheet.metadata as Record<string, unknown>)["app"]).toBe("sheets");
  });
});

describe("PostgresSheetsStore tenant storage snapshots", () => {
  it("writes an initial spreadsheet snapshot through tenant-resolved storage", async () => {
    const recording = createRecordingSheetsSql();
    const storage = new RecordingStorageClient();
    const store = new PostgresSheetsStore(recording.sql, {
      storageResolver: storageResolverFor(storage),
    });

    const sheet = await store.createSheet({
      orgId,
      actorId,
      title: "Storage Sheet",
      tabNames: ["Forecast"],
    });

    expect(sheet.id).toBe("f2100000-0000-4000-8000-000000000001");
    expect(storage.puts).toHaveLength(2);
    const latestPut = storage.puts[0];
    const versionPut = storage.puts[1];
    expect(latestPut?.key).toBe(`sheets/${orgId}/${sheet.id}`);
    expect(versionPut?.key).toBe(`sheets/${orgId}/${sheet.id}/versions/1`);
    expect(latestPut?.contentType).toBe("application/vnd.helix.spreadsheet+json");
    expect(versionPut?.contentType).toBe("application/vnd.helix.spreadsheet+json");
    const snapshot: unknown = JSON.parse(new TextDecoder().decode(latestPut?.body));
    expect(snapshot).toMatchObject({
      app: "sheets",
      version: 1,
      sheet: { id: sheet.id, orgId, title: "Storage Sheet" },
      tabs: [{ name: "Forecast", position: 0 }],
      cells: [],
    });
    expect(new TextDecoder().decode(versionPut?.body)).toBe(
      new TextDecoder().decode(latestPut?.body),
    );
    const objectInsert = recording.calls.find((call) => call.text.includes("insert into objects"));
    expect(objectInsert?.values).toContain(latestPut?.body.byteLength);
    expect(objectInsert?.values).toContain(sha256Hex(latestPut?.body ?? new Uint8Array()));
    const versionInsert = recording.calls.find((call) =>
      call.text.includes("insert into drive_versions"),
    );
    expect(versionInsert?.values).toContain(1);
    expect(versionInsert?.values).toContain(versionPut?.key);
    expect(versionInsert?.values).toContain(sha256Hex(versionPut?.body ?? new Uint8Array()));
  });

  it("refreshes the spreadsheet snapshot and object hash after cell mutations", async () => {
    const recording = createRecordingSheetsSql();
    const storage = new RecordingStorageClient();
    const store = new PostgresSheetsStore(recording.sql, {
      storageResolver: storageResolverFor(storage),
    });

    const sheet = await store.createSheet({
      orgId,
      actorId,
      title: "Storage Sheet",
      tabNames: ["Forecast"],
    });
    const tabId = sheet.tabs[0]?.id;
    if (tabId === undefined) {
      throw new Error("Expected initial tab.");
    }

    await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        {
          row: 2,
          col: 1,
          value: "42",
          format: { bold: true, dataValidation: { type: "number" } },
        },
      ],
    });

    expect(storage.puts).toHaveLength(4);
    const put = storage.puts[2];
    const versionPut = storage.puts[3];
    expect(put?.key).toBe(`sheets/${orgId}/${sheet.id}`);
    expect(versionPut?.key).toBe(`sheets/${orgId}/${sheet.id}/versions/2`);
    const snapshot: unknown = JSON.parse(new TextDecoder().decode(put?.body));
    expect(snapshot).toMatchObject({
      app: "sheets",
      version: 1,
      sheet: { id: sheet.id, orgId, title: "Storage Sheet" },
      tabs: [{ id: tabId, name: "Forecast", position: 0 }],
      cells: [
        {
          tabId,
          row: 2,
          col: 1,
          value: "42",
          formula: null,
          calcValue: "42",
          dependencies: [],
          formulaError: null,
          format: { bold: true, dataValidation: { type: "number" } },
        },
      ],
    });
    const objectUpdate = recording.calls.find((call) => call.text.includes("update objects"));
    expect(objectUpdate?.values).toContain(put?.body.byteLength);
    expect(objectUpdate?.values).toContain(sha256Hex(put?.body ?? new Uint8Array()));
    const versionInserts = recording.calls.filter((call) =>
      call.text.includes("insert into drive_versions"),
    );
    expect(versionInserts[1]?.values).toContain(2);
    expect(versionInserts[1]?.values).toContain(versionPut?.key);
    expect(versionInserts[1]?.values).toContain(sha256Hex(versionPut?.body ?? new Uint8Array()));
  });

  it("does not insert object metadata when the snapshot write fails", async () => {
    const recording = createRecordingSheetsSql();
    const store = new PostgresSheetsStore(recording.sql, {
      storageResolver: storageResolverFor(new ThrowingStorageClient()),
    });

    await expect(store.createSheet({ orgId, actorId, title: "Broken" })).rejects.toThrow(
      "storage unavailable",
    );
    expect(recording.calls.some((call) => call.text.includes("insert into objects"))).toBe(false);
  });

  it("fans out notifications for spreadsheet comment mentions", async () => {
    const recording = createRecordingSheetsSql();
    const store = new PostgresSheetsStore(recording.sql);

    await store.createComment({
      orgId,
      actorId,
      sheetId: "f2100000-0000-4000-8000-000000000001",
      body: "@maya please review this renewal",
      anchor: {
        type: "sheet-range",
        tabId: "f2100000-0000-4000-8000-000000000002",
        label: "B2",
        range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
      },
      metadata: { mentionsText: ["@owner", "Maya Chen", "Maya Chen"] },
    });

    const notifications = recording.calls.filter((call) =>
      call.text.includes("insert into notifications"),
    );
    const actorLookup = recording.calls.find(
      (call) => call.text.includes("from actors") && call.text.includes("permissions"),
    );
    expect(actorLookup?.text).toContain("p.resource_type = 'object'");
    expect(notifications).toHaveLength(1);
    const payload = notifications[0]?.values[7] as Record<string, unknown> | undefined;
    expect(notifications[0]?.values).toEqual(
      expect.arrayContaining([
        orgId,
        otherActorId,
        "sheets.comment.mention",
        "sheet",
        "f2100000-0000-4000-8000-000000000001",
        'Owner Admin mentioned you in "Storage Sheet".',
        "@maya please review this renewal",
      ]),
    );
    expect(payload).toMatchObject({
      sheetId: "f2100000-0000-4000-8000-000000000001",
      commentId: "f2100000-0000-4000-8000-000000000004",
      mentionedByActorId: actorId,
      mentionsText: ["owner", "maya chen", "maya"],
    });
  });

  it("records protected-range audit activity when sheet metadata protections change", async () => {
    const recording = createRecordingSheetsSql();
    const store = new PostgresSheetsStore(recording.sql);
    const sheetId = "f2100000-0000-4000-8000-000000000001";
    const tabId = "f2100000-0000-4000-8000-000000000002";
    const lockedArr = {
      id: "protected-arr",
      tabId,
      label: "Locked ARR",
      mode: "warn",
      range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
    };

    await store.updateSheet({
      orgId,
      actorId,
      sheetId,
      metadata: { protectedRanges: [lockedArr] },
    });
    await store.updateSheet({
      orgId,
      actorId,
      sheetId,
      metadata: { protectedRanges: [lockedArr] },
    });
    await store.updateSheet({
      orgId,
      actorId,
      sheetId,
      metadata: {
        protectedRanges: [
          {
            ...lockedArr,
            mode: "block",
            range: { ...lockedArr.range, endRow: 3 },
          },
        ],
      },
    });
    await store.updateSheet({
      orgId,
      actorId,
      sheetId,
      metadata: { protectedRanges: [] },
    });

    const activity = recording.calls.filter(
      (call) =>
        call.text.includes("insert into activity") &&
        call.values[2] === "sheets.protected_ranges.updated",
    );

    expect(activity).toHaveLength(3);
    expect(activity.map((call) => call.values[3])).toEqual([sheetId, sheetId, sheetId]);
    expect(activity[0]?.values[4]).toMatchObject({
      sheetId,
      title: "Storage Sheet",
      protectedRanges: {
        added: [lockedArr],
        removed: [],
        changed: [],
      },
    });
    expect(activity[1]?.values[4]).toMatchObject({
      sheetId,
      protectedRanges: {
        added: [],
        removed: [],
        changed: [
          {
            before: lockedArr,
            after: { ...lockedArr, mode: "block", range: { ...lockedArr.range, endRow: 3 } },
          },
        ],
      },
    });
    expect(activity[2]?.values[4]).toMatchObject({
      sheetId,
      protectedRanges: {
        added: [],
        removed: [{ ...lockedArr, mode: "block", range: { ...lockedArr.range, endRow: 3 } }],
        changed: [],
      },
    });

    const outbox = recording.calls.filter(
      (call) =>
        call.text.includes("insert into outbox") &&
        call.values[0] === "activity.sheets.protected_ranges.updated",
    );
    expect(outbox).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// PostgresSheetsStore — shared-PK objects row integration tests
// ---------------------------------------------------------------------------

function createSql(): postgres.Sql {
  const url =
    process.env.DATABASE_URL ?? "postgres://helix:helix_dev_password@localhost:28432/helix";
  return postgres(url, { max: 2, prepare: false });
}

interface RecordedSqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSheetsSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedSqlCall[];
} {
  const calls: RecordedSqlCall[] = [];
  const now = new Date("2026-05-24T10:00:00.000Z");
  let sheetRow = {
    id: "f2100000-0000-4000-8000-000000000001",
    org_id: orgId,
    owner_actor_id: actorId,
    created_by_actor_id: otherActorId,
    title: "Storage Sheet",
    metadata: {} as Record<string, unknown>,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  const tabRow = {
    id: "f2100000-0000-4000-8000-000000000002",
    org_id: orgId,
    sheet_id: sheetRow.id,
    name: "Forecast",
    position: 0,
    metadata: {},
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  const commentRow = {
    id: "f2100000-0000-4000-8000-000000000004",
    org_id: orgId,
    object_id: sheetRow.id,
    parent_comment_id: null,
    actor_id: actorId,
    anchor: {},
    body: "",
    status: "open",
    metadata: {},
    resolved_at: null,
    created_at: now,
    updated_at: null,
  };
  const cells: Array<{
    id: string;
    org_id: string;
    sheet_tab_id: string;
    row: number;
    col: number;
    value: string;
    formula: string | null;
    calc_value: string | null;
    dependencies: readonly string[];
    formula_error: string | null;
    format: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }> = [];
  let versionCount = 0;
  const tx = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, values });
      if (text.includes("insert into sheets")) {
        return Promise.resolve([{ ...sheetRow, title: String(values[3]) }]);
      }
      if (text.includes("insert into sheet_tabs")) {
        return Promise.resolve([
          { ...tabRow, name: String(values[2]), position: Number(values[3]) },
        ]);
      }
      if (text.includes("from sheet_tabs t")) {
        return Promise.resolve([tabRow]);
      }
      if (text.includes("insert into sheet_cells")) {
        cells.splice(0, cells.length, {
          id: "f2100000-0000-4000-8000-000000000003",
          org_id: orgId,
          sheet_tab_id: String(values[1]),
          row: Number(values[2]),
          col: Number(values[3]),
          value: String(values[4]),
          formula: null,
          calc_value: String(values[4]),
          dependencies: [],
          formula_error: null,
          format: values[5] as Record<string, unknown>,
          created_at: now,
          updated_at: now,
        });
        return Promise.resolve([]);
      }
      if (text.includes("update sheets") && text.includes("set title =")) {
        sheetRow = {
          ...sheetRow,
          title: String(values[0]),
          metadata: values[1] as Record<string, unknown>,
          updated_at: now,
        };
        return Promise.resolve([sheetRow]);
      }
      if (text.includes("insert into drive_comments")) {
        return Promise.resolve([
          {
            ...commentRow,
            parent_comment_id: values[2] as string | null,
            anchor: values[4] as Record<string, unknown>,
            body: String(values[5]),
            metadata: values[6] as Record<string, unknown>,
          },
        ]);
      }
      if (text.includes("from actors")) {
        return Promise.resolve([
          {
            id: actorId,
            display_name: "Owner Admin",
            email: "owner@example.com",
          },
          {
            id: otherActorId,
            display_name: "Maya Chen",
            email: "maya@example.com",
          },
        ]);
      }
      if (text.includes("insert into notifications")) {
        return Promise.resolve([
          {
            id: "f2100000-0000-4000-8000-000000000005",
            org_id: values[0],
            actor_id: values[1],
            verb: values[2],
            object_type: values[3],
            object_id: values[4],
            summary: values[5],
            body: values[6],
            payload: values[7],
            created_at: now,
            read_at: null,
          },
        ]);
      }
      if (text.includes("update sheet_cells") && text.includes("formula")) {
        const cell = cells[0];
        if (cell !== undefined) {
          cells[0] = {
            ...cell,
            formula: values[0] as string | null,
            calc_value: values[1] as string | null,
            dependencies: values[2] as readonly string[],
            formula_error: values[3] as string | null,
          };
        }
        return Promise.resolve([]);
      }
      if (text.includes("max(version_number)")) {
        return Promise.resolve([{ version_number: versionCount + 1 }]);
      }
      if (text.includes("insert into drive_versions")) {
        versionCount += 1;
        return Promise.resolve([]);
      }
      if (text.includes("from sheets")) {
        return Promise.resolve([sheetRow]);
      }
      if (text.includes("from sheet_tabs") && text.includes("where org_id")) {
        return Promise.resolve([tabRow]);
      }
      if (text.includes("from sheet_cells c")) {
        return Promise.resolve(cells);
      }
      if (text.includes("from sheet_cells")) {
        return Promise.resolve(cells);
      }
      return Promise.resolve([]);
    },
    {
      begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
        callback(tx as unknown as postgres.TransactionSql),
      json: (value: unknown) => value,
    },
  );
  return { sql: tx as unknown as postgres.Sql, calls };
}

function storageResolverFor(storage: SheetSnapshotStorageClient): SheetSnapshotStorageResolver {
  return () => ({
    client: storage,
  });
}

class RecordingStorageClient implements SheetSnapshotStorageClient {
  readonly puts: Array<{
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
  }> = [];

  async put(object: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
  }): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<null> {
    return null;
  }

  async delete(): Promise<void> {}
}

class ThrowingStorageClient extends RecordingStorageClient {
  override async put(): Promise<void> {
    throw new Error("storage unavailable");
  }
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// Deterministic UUIDs in the f200… range to avoid collision with other tests.
const PG_ORG_ID = "f2000000-0000-4000-8000-000000000001";
const PG_ACTOR_ID = "f2000000-0000-4000-8000-000000000002";
const PG_FOLDER_ID = "f2000000-0000-4000-8000-000000000003";

describe(
  "PostgresSheetsStore — createSheet creates shared-PK objects row",
  {
    skip: skipUnlessLiveDatabase("Sheets store (live PostgreSQL)"),
  },
  () => {
    let sql: postgres.Sql;
    let store: PostgresSheetsStore;
    const createdSheetIds: string[] = [];

    beforeAll(async () => {
      sql = createSql();
      store = new PostgresSheetsStore(sql);

      // Seed a test actor so FK constraints are satisfied.
      await sql`
        insert into actors (id, org_id, type, display_name, scopes)
        values (${PG_ACTOR_ID}, ${PG_ORG_ID}, 'user', 'Sheets Store Test Actor', '{}')
        on conflict (id) do nothing
      `;
    });

    afterAll(async () => {
      // Clean up created sheets and their objects rows.
      if (createdSheetIds.length > 0) {
        await sql`delete from permissions where resource_id = any(${createdSheetIds}::uuid[])`;
        await sql`delete from objects where id = any(${createdSheetIds}::uuid[])`;
        await sql`delete from sheet_tabs where sheet_id = any(${createdSheetIds}::uuid[])`;
        await sql`delete from sheets where id = any(${createdSheetIds}::uuid[])`;
      }
      await sql.end();
    });

    it("inserts an objects row with kind=file, app=sheets, name, sheetId on create", async () => {
      const sheet = await store.createSheet({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Q3 Forecast",
      });
      createdSheetIds.push(sheet.id);

      const rows = (await sql`
        select id, org_id, owner_actor_id, kind, storage_key, mime_type, metadata
        from objects
        where id = ${sheet.id}
      `) as unknown as ReadonlyArray<{
        id: string;
        org_id: string;
        owner_actor_id: string;
        kind: string;
        storage_key: string;
        mime_type: string;
        metadata: Record<string, unknown>;
      }>;

      expect(rows).toHaveLength(1);
      const obj = rows[0];
      expect(obj?.id).toBe(sheet.id);
      expect(obj?.kind).toBe("file");
      expect(obj?.storage_key).toBe(`sheets/${PG_ORG_ID}/${sheet.id}`);
      expect(obj?.mime_type).toBe("application/vnd.helix.spreadsheet");
      expect(obj?.metadata["app"]).toBe("sheets");
      expect(obj?.metadata["name"]).toBe("Q3 Forecast");
      expect(obj?.metadata["sheetId"]).toBe(sheet.id);
      expect(obj?.metadata["folderId"]).toBeNull();
      expect(obj?.metadata["preview"]).toMatchObject({
        kind: "text",
        status: "available",
        mimeType: "application/vnd.helix.spreadsheet",
        text: "Q3 Forecast\nSheet1",
      });
    });

    it("stores folderId in objects metadata when provided", async () => {
      const sheet = await store.createSheet({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Budget 2025",
        folderId: PG_FOLDER_ID,
      });
      createdSheetIds.push(sheet.id);

      const rows = (await sql`
        select metadata from objects where id = ${sheet.id}
      `) as unknown as ReadonlyArray<{ metadata: Record<string, unknown> }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata["folderId"]).toBe(PG_FOLDER_ID);
      expect(rows[0]?.metadata["app"]).toBe("sheets");
      expect(rows[0]?.metadata["name"]).toBe("Budget 2025");
    });

    it("grants owner permission on the objects row", async () => {
      const sheet = await store.createSheet({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Permissions Test",
      });
      createdSheetIds.push(sheet.id);

      const rows = (await sql`
        select role from permissions
        where resource_type = 'object'
          and resource_id = ${sheet.id}
          and actor_id = ${PG_ACTOR_ID}
      `) as unknown as ReadonlyArray<{ role: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("owner");
    });
  },
);
