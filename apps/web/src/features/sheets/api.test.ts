import { describe, expect, it, vi } from "vitest";
import {
  copySheet,
  createSheetComment,
  createSheet,
  createSheetTab,
  deleteSheetComment,
  deleteSheet,
  deleteSheetTab,
  exportSheet,
  getSheet,
  getSheetTab,
  importCsvSheet,
  importOdsSheet,
  importTsvSheet,
  importXlsxSheet,
  isBackendSheetsId,
  listSheetComments,
  listSheetVersions,
  listSheets,
  reopenSheetComment,
  restoreSheetVersion,
  resolveSheetComment,
  sortSheetRange,
  updateSheet,
  updateSheetComment,
  updateSheetCells,
  updateSheetTab,
} from "./api";

const sheetId = "11111111-1111-4111-8111-111111111111";
const tabId = "22222222-2222-4222-8222-222222222222";

function jsonFetch(body: unknown, status = 200) {
  return vi.fn(() => Promise.resolve(Response.json(body, { status })));
}

describe("sheets API", () => {
  it("lists spreadsheets through sheets.list with pagination", async () => {
    const fetchImpl = jsonFetch({ sheets: [], total: 0, limit: 100, offset: 0 });
    await expect(listSheets({ query: "q3", limit: 100 }, fetchImpl)).resolves.toEqual({
      sheets: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "q3", limit: 100, offset: 0 }),
    });
  });

  it("sorts a selected range through sheets.range.sort", async () => {
    const fetchImpl = jsonFetch({ id: tabId, sheetId, name: "Tab", position: 0, cells: [] });
    await expect(
      sortSheetRange(
        {
          tabId,
          direction: "asc",
          range: { startRow: 1, startCol: 0, endRow: 3, endCol: 2 },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: tabId });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.range.sort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabId,
        direction: "asc",
        range: { startRow: 1, startCol: 0, endRow: 3, endCol: 2 },
      }),
    });
  });

  it("gets a spreadsheet with its tabs through sheets.get", async () => {
    const fetchImpl = jsonFetch({ id: sheetId, title: "Renewals", tabs: [] });
    await expect(getSheet({ sheetId }, fetchImpl)).resolves.toMatchObject({
      id: sheetId,
      title: "Renewals",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId }),
    });
  });

  it("creates a spreadsheet through sheets.create", async () => {
    const fetchImpl = jsonFetch({ id: sheetId, title: "New", tabs: [] });
    await createSheet({ title: "New", tabNames: ["Tab A"] }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New", tabNames: ["Tab A"], metadata: {} }),
    });
  });

  it("copies a spreadsheet through sheets.copy", async () => {
    const fetchImpl = jsonFetch({ id: sheetId, title: "New (Copy)", tabs: [] });
    await copySheet(
      {
        sheetId,
        title: "New (Copy)",
        metadata: { createdFrom: "test.copy" },
      },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.copy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sheetId,
        title: "New (Copy)",
        metadata: { createdFrom: "test.copy" },
      }),
    });
  });

  it("imports CSV through sheets.import-csv", async () => {
    const fetchImpl = jsonFetch({
      id: sheetId,
      title: "Renewals",
      tabs: [{ id: tabId, sheetId, name: "Renewals", position: 0 }],
      import: {
        format: "csv",
        filename: "Renewals.csv",
        rowCount: 2,
        columnCount: 2,
        populatedCellCount: 4,
      },
    });
    await expect(
      importCsvSheet(
        {
          filename: "Renewals.csv",
          title: "Renewals",
          folderId: "33333333-3333-4333-8333-333333333333",
          csvText: "Customer,ARR\nAcme,1200",
          metadata: { source: "test" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: sheetId, import: { populatedCellCount: 4 } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.import-csv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Renewals.csv",
        title: "Renewals",
        folderId: "33333333-3333-4333-8333-333333333333",
        csvText: "Customer,ARR\nAcme,1200",
        metadata: { source: "test" },
      }),
    });
  });

  it("imports XLSX through sheets.import-xlsx", async () => {
    const fetchImpl = jsonFetch({
      id: sheetId,
      title: "Forecast",
      tabs: [{ id: tabId, sheetId, name: "Summary", position: 0 }],
      import: {
        format: "xlsx",
        filename: "Forecast.xlsx",
        sheetCount: 1,
        rowCount: 2,
        columnCount: 2,
        populatedCellCount: 4,
      },
    });
    await expect(
      importXlsxSheet(
        {
          filename: "Forecast.xlsx",
          title: "Forecast",
          folderId: "33333333-3333-4333-8333-333333333333",
          contentBase64: "eGxzeA==",
          metadata: { source: "test" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: sheetId, import: { sheetCount: 1 } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.import-xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Forecast.xlsx",
        title: "Forecast",
        folderId: "33333333-3333-4333-8333-333333333333",
        contentBase64: "eGxzeA==",
        metadata: { source: "test" },
      }),
    });
  });

  it("imports ODS through sheets.import-ods", async () => {
    const fetchImpl = jsonFetch({
      id: sheetId,
      title: "Forecast",
      tabs: [{ id: tabId, sheetId, name: "Summary", position: 0 }],
      import: {
        format: "ods",
        filename: "Forecast.ods",
        sheetCount: 1,
        rowCount: 2,
        columnCount: 2,
        populatedCellCount: 4,
      },
    });
    await expect(
      importOdsSheet(
        {
          filename: "Forecast.ods",
          title: "Forecast",
          folderId: "33333333-3333-4333-8333-333333333333",
          contentBase64: "b2Rz",
          metadata: { source: "test" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: sheetId, import: { sheetCount: 1 } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.import-ods", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Forecast.ods",
        title: "Forecast",
        folderId: "33333333-3333-4333-8333-333333333333",
        contentBase64: "b2Rz",
        metadata: { source: "test" },
      }),
    });
  });

  it("imports TSV through sheets.import-tsv", async () => {
    const fetchImpl = jsonFetch({
      id: sheetId,
      title: "Renewals",
      tabs: [{ id: tabId, sheetId, name: "Renewals", position: 0 }],
      import: {
        format: "tsv",
        filename: "Renewals.tsv",
        rowCount: 2,
        columnCount: 2,
        populatedCellCount: 4,
      },
    });
    await expect(
      importTsvSheet(
        {
          filename: "Renewals.tsv",
          title: "Renewals",
          folderId: "33333333-3333-4333-8333-333333333333",
          tsvText: "Customer\tARR\nAcme\t1200",
          metadata: { source: "test" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: sheetId, import: { populatedCellCount: 4 } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.import-tsv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Renewals.tsv",
        title: "Renewals",
        folderId: "33333333-3333-4333-8333-333333333333",
        tsvText: "Customer\tARR\nAcme\t1200",
        metadata: { source: "test" },
      }),
    });
  });

  it("exports a spreadsheet through sheets.export", async () => {
    const fetchImpl = jsonFetch({
      sheetId,
      format: "xlsx",
      filename: "forecast.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 1024,
      contentBase64: "UEsDBA==",
      metadata: { generatedBy: "helix.sheets.export.xlsx" },
    });
    await expect(exportSheet({ sheetId, format: "xlsx", tabId }, fetchImpl)).resolves.toMatchObject(
      {
        sheetId,
        format: "xlsx",
        filename: "forecast.xlsx",
      },
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId, format: "xlsx", tabId }),
    });
  });

  it("lists and restores spreadsheet versions through sheets.version tools", async () => {
    const versionId = "44444444-4444-4444-8444-444444444444";
    const listFetch = jsonFetch({
      versions: [
        {
          id: versionId,
          sheetId,
          versionNumber: 2,
          mimeType: "application/vnd.helix.spreadsheet+json",
          byteSize: 512,
          sha256: "abc123",
          metadata: { title: "Forecast", tabCount: 1, cellCount: 8 },
          createdByActorId: "actor-1",
          createdAt: "2026-05-28T12:00:00.000Z",
        },
      ],
    });
    await expect(listSheetVersions({ sheetId, limit: 5 }, listFetch)).resolves.toHaveLength(1);
    expect(listFetch).toHaveBeenCalledWith("/api/tools/sheets.version.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId, limit: 5 }),
    });

    const restoreFetch = jsonFetch({ id: sheetId, title: "Forecast", tabs: [] });
    await expect(restoreSheetVersion({ sheetId, versionId }, restoreFetch)).resolves.toMatchObject({
      id: sheetId,
      title: "Forecast",
    });
    expect(restoreFetch).toHaveBeenCalledWith("/api/tools/sheets.version.restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId, versionId }),
    });
  });

  it("renames a spreadsheet through sheets.update", async () => {
    const fetchImpl = jsonFetch({ id: sheetId, title: "Renamed", tabs: [] });
    await updateSheet({ sheetId, title: "Renamed" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId, title: "Renamed" }),
    });
  });

  it("deletes a spreadsheet through sheets.delete", async () => {
    const fetchImpl = jsonFetch({ sheetId, deletedAt: "2026-05-21T00:00:00.000Z" });
    await expect(deleteSheet({ sheetId }, fetchImpl)).resolves.toMatchObject({ sheetId });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId }),
    });
  });

  it("creates, renames, deletes, and reads tabs", async () => {
    const createFetch = jsonFetch({ id: tabId, sheetId, name: "Tab", position: 1 });
    await createSheetTab({ sheetId, name: "Tab", position: 1 }, createFetch);
    expect(createFetch).toHaveBeenCalledWith("/api/tools/sheets.tab.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId, name: "Tab", position: 1, metadata: {} }),
    });

    const updateFetch = jsonFetch({ id: tabId, sheetId, name: "Renamed", position: 1 });
    await updateSheetTab({ tabId, name: "Renamed" }, updateFetch);
    expect(updateFetch).toHaveBeenCalledWith("/api/tools/sheets.tab.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId, name: "Renamed" }),
    });

    const deleteFetch = jsonFetch({ tabId, deletedAt: null });
    await deleteSheetTab({ tabId }, deleteFetch);
    expect(deleteFetch).toHaveBeenCalledWith("/api/tools/sheets.tab.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId }),
    });

    const getFetch = jsonFetch({ id: tabId, sheetId, name: "Tab", position: 1, cells: [] });
    await expect(getSheetTab({ tabId }, getFetch)).resolves.toMatchObject({ id: tabId });
    expect(getFetch).toHaveBeenCalledWith("/api/tools/sheets.tab.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId }),
    });

    const windowedGetFetch = jsonFetch({ id: tabId, sheetId, name: "Tab", position: 1, cells: [] });
    await expect(
      getSheetTab(
        { tabId, window: { startRow: 10, startCol: 2, endRow: 20, endCol: 8 } },
        windowedGetFetch,
      ),
    ).resolves.toMatchObject({ id: tabId });
    expect(windowedGetFetch).toHaveBeenCalledWith("/api/tools/sheets.tab.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabId,
        window: { startRow: 10, startCol: 2, endRow: 20, endCol: 8 },
      }),
    });
  });

  it("persists batched cell edits through sheets.cells.update", async () => {
    const fetchImpl = jsonFetch({
      id: tabId,
      sheetId,
      name: "Tab",
      position: 0,
      cells: [
        {
          id: "cell-1",
          sheetTabId: tabId,
          row: 1,
          col: 2,
          value: "=SUM(A1:A2)",
          formula: "SUM(A1:A2)",
          calcValue: "30",
          dependencies: ["A1", "A2"],
          formulaError: null,
          format: {},
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
        },
      ],
    });
    await expect(
      updateSheetCells(
        {
          tabId,
          edits: [
            {
              row: 1,
              col: 2,
              value: "Hello",
              format: {
                bold: true,
                align: "right",
                numberFormat: "custom",
                customNumberFormat: "#,##0.00",
              },
            },
          ],
          window: { startRow: 1, startCol: 2, endRow: 1, endCol: 2 },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      cells: [
        {
          formula: "SUM(A1:A2)",
          calcValue: "30",
          dependencies: ["A1", "A2"],
          formulaError: null,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.cells.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tabId,
        edits: [
          {
            row: 1,
            col: 2,
            value: "Hello",
            format: {
              bold: true,
              align: "right",
              numberFormat: "custom",
              customNumberFormat: "#,##0.00",
            },
          },
        ],
        window: { startRow: 1, startCol: 2, endRow: 1, endCol: 2 },
      }),
    });
  });

  it("lists, creates, resolves, reopens, updates, and deletes sheet comments through tools", async () => {
    const comment = {
      id: "33333333-3333-4333-8333-333333333333",
      sheetId,
      parentCommentId: null,
      actorId: "44444444-4444-4444-8444-444444444444",
      anchor: {
        type: "sheet-range",
        tabId,
        label: "B2:C2",
        range: { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
      },
      body: "Check renewal math",
      status: "open",
      metadata: {},
      resolvedAt: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: null,
    };

    const listFetch = jsonFetch({ comments: [comment] });
    await expect(listSheetComments({ sheetId, status: "open" }, listFetch)).resolves.toEqual([
      comment,
    ]);
    expect(listFetch).toHaveBeenCalledWith("/api/tools/sheets.comment.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheetId, status: "open" }),
    });

    const createFetch = jsonFetch(comment);
    await createSheetComment(
      {
        sheetId,
        body: "Check renewal math",
        anchor: comment.anchor,
        metadata: { source: "test" },
        parentCommentId: comment.id,
      },
      createFetch,
    );
    expect(createFetch).toHaveBeenCalledWith("/api/tools/sheets.comment.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sheetId,
        body: "Check renewal math",
        anchor: comment.anchor,
        metadata: { source: "test" },
        parentCommentId: comment.id,
      }),
    });

    const resolveFetch = jsonFetch({ ...comment, status: "resolved" });
    await resolveSheetComment({ commentId: comment.id }, resolveFetch);
    expect(resolveFetch).toHaveBeenCalledWith("/api/tools/sheets.comment.resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId: comment.id }),
    });

    const reopenFetch = jsonFetch(comment);
    await reopenSheetComment({ commentId: comment.id }, reopenFetch);
    expect(reopenFetch).toHaveBeenCalledWith("/api/tools/sheets.comment.reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId: comment.id }),
    });

    const updateFetch = jsonFetch({ ...comment, body: "Updated comment" });
    await updateSheetComment({ commentId: comment.id, body: "Updated comment" }, updateFetch);
    expect(updateFetch).toHaveBeenCalledWith("/api/tools/sheets.comment.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId: comment.id, body: "Updated comment" }),
    });

    const deleteFetch = jsonFetch(comment);
    await deleteSheetComment({ commentId: comment.id }, deleteFetch);
    expect(deleteFetch).toHaveBeenCalledWith("/api/tools/sheets.comment.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId: comment.id }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = jsonFetch({ error: "missing sheets scope" }, 403);
    await expect(createSheet({ title: "x" }, fetchImpl)).rejects.toThrow("missing sheets scope");
  });

  it("recognizes UUID sheet ids as backend ids", () => {
    expect(isBackendSheetsId(sheetId)).toBe(true);
    expect(isBackendSheetsId("sh1")).toBe(false);
    expect(isBackendSheetsId(undefined)).toBe(false);
  });
});
