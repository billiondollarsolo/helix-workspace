import { describe, expect, it } from "vitest";
import type { SheetsApiCell, SheetsApiSheet } from "./api";
import {
  diffCellEdit,
  gridFromCells,
  gridToCellEdits,
  MIN_GRID_COLS,
  MIN_GRID_ROWS,
  mergeBackendSheets,
} from "./model";
import { SHEETS_LIST } from "./seed";

function cell(row: number, col: number, value: string): SheetsApiCell {
  return {
    id: `${String(row)}-${String(col)}`,
    sheetTabId: "tab",
    row,
    col,
    value,
    format: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

describe("gridFromCells", () => {
  it("builds a dense grid padded to the minimum shape", () => {
    const grid = gridFromCells([]);
    expect(grid).toHaveLength(MIN_GRID_ROWS);
    expect(grid[0]).toHaveLength(MIN_GRID_COLS);
  });

  it("places sparse cells at their coordinates", () => {
    const grid = gridFromCells([cell(0, 0, "Customer"), cell(3, 5, "Green")]);
    expect(grid[0]?.[0]).toBe("Customer");
    expect(grid[3]?.[5]).toBe("Green");
    expect(grid[1]?.[0]).toBe("");
  });
});

describe("diffCellEdit", () => {
  it("returns null when the value is unchanged", () => {
    expect(diffCellEdit([["a"]], 0, 0, "a")).toBeNull();
  });

  it("returns an edit when the value changed", () => {
    expect(diffCellEdit([["a"]], 0, 0, "b")).toEqual({ row: 0, col: 0, value: "b" });
  });

  it("treats a missing cell as empty", () => {
    expect(diffCellEdit([[]], 5, 5, "x")).toEqual({ row: 5, col: 5, value: "x" });
  });
});

describe("gridToCellEdits", () => {
  it("emits only the populated cells", () => {
    const edits = gridToCellEdits([
      ["A", ""],
      ["", "B"],
    ]);
    expect(edits).toEqual([
      { row: 0, col: 0, value: "A" },
      { row: 1, col: 1, value: "B" },
    ]);
  });
});

describe("mergeBackendSheets", () => {
  const backendRow: SheetsApiSheet = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerActorId: null,
    createdByActorId: null,
    title: "Backend sheet",
    metadata: { ownerName: "Rumi Tanaka", shared: 3 },
    deletedAt: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };

  it("returns seed rows unchanged when the backend yields nothing", () => {
    const merged = mergeBackendSheets(SHEETS_LIST, undefined);
    expect(merged).toHaveLength(SHEETS_LIST.length);
    expect(merged.every((row) => row.source === "seed")).toBe(true);
  });

  it("merges backend sheets ahead of the seed list", () => {
    const merged = mergeBackendSheets(SHEETS_LIST, [backendRow]);
    expect(merged).toHaveLength(SHEETS_LIST.length + 1);
    expect(merged[0]?.id).toBe(backendRow.id);
    expect(merged[0]?.source).toBe("backend");
    expect(merged[0]?.owner).toBe("Rumi Tanaka");
    expect(merged[0]?.shared).toBe(3);
  });
});
