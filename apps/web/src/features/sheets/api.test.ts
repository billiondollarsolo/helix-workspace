import { describe, expect, it, vi } from "vitest";
import {
  createSheet,
  createSheetTab,
  deleteSheet,
  deleteSheetTab,
  getSheet,
  getSheetTab,
  isBackendSheetsId,
  listSheets,
  updateSheet,
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
  });

  it("persists batched cell edits through sheets.cells.update", async () => {
    const fetchImpl = jsonFetch({ id: tabId, sheetId, name: "Tab", position: 0, cells: [] });
    await updateSheetCells(
      { tabId, edits: [{ row: 1, col: 2, value: "Hello" }] },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/sheets.cells.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId, edits: [{ row: 1, col: 2, value: "Hello" }] }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = jsonFetch({ error: "missing sheets scope" }, 403);
    await expect(createSheet({ title: "x" }, fetchImpl)).rejects.toThrow(
      "missing sheets scope",
    );
  });

  it("recognizes UUID sheet ids as backend ids", () => {
    expect(isBackendSheetsId(sheetId)).toBe(true);
    expect(isBackendSheetsId("sh1")).toBe(false);
    expect(isBackendSheetsId(undefined)).toBe(false);
  });
});
