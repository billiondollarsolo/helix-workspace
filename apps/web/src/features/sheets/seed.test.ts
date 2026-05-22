import { describe, expect, it } from "vitest";
import {
  cellReference,
  columnLetter,
  parseCurrency,
  SHEET_DATA,
  SHEET_TABS,
  SHEETS_LIST,
  sumArr,
} from "./seed";

describe("sheets seed data", () => {
  it("exposes the six list spreadsheets with unique ids", () => {
    expect(SHEETS_LIST).toHaveLength(6);
    const ids = new Set(SHEETS_LIST.map((sheet) => sheet.id));
    expect(ids.size).toBe(6);
  });

  it("provides a grid for every tab", () => {
    for (const tab of SHEET_TABS) {
      const grid = SHEET_DATA[tab.id];
      expect(grid, `grid for ${tab.id}`).toBeDefined();
      expect(grid!.length).toBeGreaterThan(1);
    }
  });

  it("uses the same seven-column header shape across tabs", () => {
    for (const tab of SHEET_TABS) {
      expect(SHEET_DATA[tab.id]![0]).toHaveLength(7);
    }
  });
});

describe("parseCurrency", () => {
  it("strips currency punctuation", () => {
    expect(parseCurrency("$420,000")).toBe(420000);
  });

  it("returns 0 for empty or non-numeric cells", () => {
    expect(parseCurrency("")).toBe(0);
    expect(parseCurrency("Green")).toBe(0);
  });
});

describe("sumArr", () => {
  it("aggregates the Customers ARR column", () => {
    expect(sumArr(SHEET_DATA.customers!)).toBe(2_160_000);
  });

  it("skips the header row", () => {
    const grid = [
      ["Customer", "ARR"],
      ["A", "$100"],
      ["B", "$200"],
    ];
    expect(sumArr(grid)).toBe(300);
  });
});

describe("columnLetter", () => {
  it("maps the first columns to A–G", () => {
    expect(["A", "B", "C", "D", "E", "F", "G"]).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map(columnLetter),
    );
  });

  it("wraps past Z into AA", () => {
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
  });
});

describe("cellReference", () => {
  it("produces A1-style references with a one-based row", () => {
    expect(cellReference(0, 0)).toBe("A1");
    expect(cellReference(1, 1)).toBe("B2");
  });
});
