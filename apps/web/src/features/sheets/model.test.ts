import { describe, expect, it } from "vitest";
import type { SheetsApiCell } from "./api";
import {
  diffCellEdit,
  gridFromCells,
  gridToCellEdits,
  MIN_GRID_COLS,
  MIN_GRID_ROWS,
} from "./model";

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

