import { describe, expect, it } from "vitest";
import { analyzeSpreadsheetRange } from "./spreadsheet-ai";

describe("spreadsheet AI assists", () => {
  it("summarizes a selected range and suggests supported formulas", () => {
    const assist = analyzeSpreadsheetRange(
      [
        ["Customer", "ARR", "Owner"],
        ["Acme", "100", "Nia"],
        ["Acme", "200", "Nia"],
      ],
      { top: 0, left: 0, bottom: 2, right: 2 },
    );

    expect(assist.summary).toBe("3 x 3 range, 9 populated cells");
    expect(assist.findings).toContain("1 numeric column detected");
    expect(assist.findings).toContain("Duplicate labels: Acme");
    expect(assist.formulas).toEqual([
      {
        id: "sum-1",
        label: "Insert SUM for ARR",
        detail: "B4 = SUM(B2:B3)",
        formula: "=SUM(B2:B3)",
        target: { row: 3, col: 1 },
      },
    ]);
  });
});
