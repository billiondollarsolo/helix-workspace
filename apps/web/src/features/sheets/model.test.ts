import { describe, expect, it } from "vitest";
import type { SheetsApiCell } from "./api";
import {
  diffCellEdit,
  displayGridFromCells,
  displayValueForCell,
  gridFromCells,
  gridToCellEdits,
  MIN_GRID_COLS,
  MIN_GRID_ROWS,
  padGrid,
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

describe("displayValueForCell", () => {
  it("shows formula calc values while preserving regular cell values", () => {
    expect(
      displayValueForCell({
        ...cell(0, 0, "=SUM(A1:A2)"),
        formula: "SUM(A1:A2)",
        calcValue: "30",
        dependencies: ["A1", "A2"],
        formulaError: null,
      }),
    ).toBe("30");
    expect(displayValueForCell(cell(0, 1, "Plain"))).toBe("Plain");
  });

  it("builds a dense display grid from formula metadata", () => {
    const grid = displayGridFromCells([
      cell(0, 0, "10"),
      {
        ...cell(0, 1, "=A1*2"),
        formula: "A1*2",
        calcValue: "20",
        dependencies: ["A1"],
        formulaError: null,
      },
    ]);

    expect(grid[0]?.[0]).toBe("10");
    expect(grid[0]?.[1]).toBe("20");
  });
});

describe("padGrid", () => {
  it("extends sparse dense grids to a stable viewport", () => {
    expect(padGrid([["A"]], 3, 4)).toEqual([
      ["A", "", "", ""],
      ["", "", "", ""],
      ["", "", "", ""],
    ]);
  });

  it("preserves larger existing dimensions", () => {
    expect(padGrid([["A", "B", "C", "D"]], 1, 2)).toEqual([["A", "B", "C", "D"]]);
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
