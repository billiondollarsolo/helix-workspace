import { describe, expect, it } from "vitest";
import { evaluateSheetFormulas } from "./formula.js";

describe("evaluateSheetFormulas", () => {
  it("evaluates arithmetic formulas and cell references", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "10"),
      cell(0, 1, "5"),
      cell(0, 2, "=A1+B1*2"),
    ]);

    expect(result.get("0:2")).toMatchObject({
      formula: "A1+B1*2",
      calcValue: "20",
      dependencies: ["A1", "B1"],
      error: null,
    });
  });

  it("evaluates SUM ranges and nested formula references", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "10"),
      cell(1, 0, "20"),
      cell(2, 0, "=SUM(A1:A2)"),
      cell(3, 0, "=A3+5"),
    ]);

    expect(result.get("2:0")).toMatchObject({
      calcValue: "30",
      dependencies: ["A1", "A2"],
      error: null,
    });
    expect(result.get("3:0")).toMatchObject({
      calcValue: "35",
      dependencies: ["A3"],
      error: null,
    });
  });

  it("evaluates direct aggregate formulas over ranges and literals", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "10"),
      cell(1, 0, "20"),
      cell(2, 0, "Acme"),
      cell(3, 0, ""),
      cell(0, 1, "=AVERAGE(A1:A4)"),
      cell(0, 2, "=COUNT(A1:A4)"),
      cell(0, 3, "=MIN(A1:A4,5)"),
      cell(0, 4, "=MAX(A1:A4,25)"),
      cell(0, 5, "=COUNTA(A1:A4)"),
    ]);

    expect(result.get("0:1")).toMatchObject({
      calcValue: "15",
      dependencies: ["A1", "A2", "A3", "A4"],
      error: null,
    });
    expect(result.get("0:2")).toMatchObject({
      calcValue: "2",
      dependencies: ["A1", "A2", "A3", "A4"],
      error: null,
    });
    expect(result.get("0:3")).toMatchObject({
      calcValue: "5",
      dependencies: ["A1", "A2", "A3", "A4"],
      error: null,
    });
    expect(result.get("0:4")).toMatchObject({
      calcValue: "25",
      dependencies: ["A1", "A2", "A3", "A4"],
      error: null,
    });
    expect(result.get("0:5")).toMatchObject({
      calcValue: "3",
      dependencies: ["A1", "A2", "A3", "A4"],
      error: null,
    });
  });

  it("evaluates conditional aggregate formulas", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "Region"),
      cell(0, 1, "ARR"),
      cell(1, 0, "North"),
      cell(1, 1, "10"),
      cell(2, 0, "South"),
      cell(2, 1, "20"),
      cell(3, 0, "North"),
      cell(3, 1, "30"),
      cell(4, 0, '=SUMIF(A2:A4,"North",B2:B4)'),
      cell(4, 1, '=COUNTIF(B2:B4,">=20")'),
      cell(4, 2, '=AVERAGEIF(A2:A4,"North",B2:B4)'),
      cell(4, 3, '=COUNTIF(A2:A4,"S*")'),
      cell(4, 4, '=SUMIF(B2:B4,">10")'),
    ]);

    expect(result.get("4:0")).toMatchObject({
      calcValue: "40",
      dependencies: ["A2", "A3", "A4", "B2", "B3", "B4"],
      error: null,
    });
    expect(result.get("4:1")).toMatchObject({
      calcValue: "2",
      dependencies: ["B2", "B3", "B4"],
      error: null,
    });
    expect(result.get("4:2")).toMatchObject({
      calcValue: "20",
      dependencies: ["A2", "A3", "A4", "B2", "B3", "B4"],
      error: null,
    });
    expect(result.get("4:3")).toMatchObject({
      calcValue: "1",
      dependencies: ["A2", "A3", "A4"],
      error: null,
    });
    expect(result.get("4:4")).toMatchObject({
      calcValue: "50",
      dependencies: ["B2", "B3", "B4"],
      error: null,
    });
  });

  it("reports invalid conditional aggregate ranges", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "North"),
      cell(0, 1, "10"),
      cell(1, 0, '=SUMIF(A1:A2,"North",B1:B1)'),
    ]);

    expect(result.get("1:0")).toMatchObject({
      calcValue: "#VALUE!",
      dependencies: [],
      error: "Formula ranges must have matching shapes",
    });
  });

  it("evaluates formulas with absolute A1 references", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "10"),
      cell(0, 1, "5"),
      cell(0, 2, "7"),
      cell(1, 0, "3"),
      cell(1, 1, "2"),
      cell(1, 2, "=$A$1+$B1+C$1+SUM($A$2:$B$2)"),
    ]);

    expect(result.get("1:2")).toMatchObject({
      formula: "$A$1+$B1+C$1+SUM($A$2:$B$2)",
      calcValue: "27",
      dependencies: ["A1", "A2", "B1", "B2", "C1"],
      error: null,
    });
  });

  it("evaluates formulas that reference named ranges", () => {
    const result = evaluateSheetFormulas(
      [
        cell(0, 0, "Customer"),
        cell(0, 1, "ARR"),
        cell(1, 0, "Acme"),
        cell(1, 1, "100"),
        cell(2, 0, "Bravo"),
        cell(2, 1, "150"),
        cell(3, 0, "=SUM(Revenue_Table)"),
        cell(3, 1, '=QUERY(Revenue_Table, "select sum(B)", 1)'),
        cell(4, 0, "=AVERAGE(Revenue_Table)"),
        cell(4, 1, "=COUNT(Revenue_Table)"),
        cell(5, 0, "=MIN(Revenue_Table)"),
        cell(5, 1, "=MAX(Revenue_Table)"),
      ],
      {
        namedRanges: [
          {
            name: "Revenue_Table",
            range: { startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
          },
        ],
      },
    );

    expect(result.get("3:0")).toMatchObject({
      formula: "SUM(Revenue_Table)",
      calcValue: "250",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
    expect(result.get("4:0")).toMatchObject({
      formula: "AVERAGE(Revenue_Table)",
      calcValue: "125",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
    expect(result.get("4:1")).toMatchObject({
      formula: "COUNT(Revenue_Table)",
      calcValue: "2",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
    expect(result.get("5:0")).toMatchObject({
      formula: "MIN(Revenue_Table)",
      calcValue: "100",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
    expect(result.get("5:1")).toMatchObject({
      formula: "MAX(Revenue_Table)",
      calcValue: "150",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
    expect(result.get("3:1")).toMatchObject({
      formula: 'QUERY(Revenue_Table, "select sum(B)", 1)',
      calcValue: "250",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
  });

  it("evaluates cross-tab direct, quoted range, and named-range references", () => {
    const result = evaluateSheetFormulas(
      [
        tabCell("summary", 0, 1, "125"),
        tabCell("fy-2026", 0, 0, "10"),
        tabCell("fy-2026", 1, 0, "20"),
        tabCell("model", 0, 0, "=Summary!B1*2"),
        tabCell("model", 1, 0, "=SUM('FY 2026'!A1:A2)"),
        tabCell("model", 2, 0, "=MAX(Revenue_Table)"),
      ],
      {
        currentTabId: "model",
        tabs: [
          { id: "model", name: "Model" },
          { id: "summary", name: "Summary" },
          { id: "fy-2026", name: "FY 2026" },
        ],
        namedRanges: [
          {
            name: "Revenue_Table",
            tabId: "fy-2026",
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
          },
        ],
      },
    );

    expect(result.get("model:0:0")).toMatchObject({
      formula: "Summary!B1*2",
      calcValue: "250",
      dependencies: ["Summary!B1"],
      error: null,
    });
    expect(result.get("model:1:0")).toMatchObject({
      formula: "SUM('FY 2026'!A1:A2)",
      calcValue: "30",
      dependencies: ["'FY 2026'!A1", "'FY 2026'!A2"],
      error: null,
    });
    expect(result.get("model:2:0")).toMatchObject({
      formula: "MAX(Revenue_Table)",
      calcValue: "20",
      dependencies: ["'FY 2026'!A1", "'FY 2026'!A2"],
      error: null,
    });
  });

  it("reports unknown named ranges", () => {
    const result = evaluateSheetFormulas([cell(0, 0, "=SUM(Missing_Range)")]);

    expect(result.get("0:0")).toMatchObject({
      calcValue: "#NAME?",
      dependencies: [],
      error: "Unknown named range",
    });
  });

  it("reports circular references without throwing", () => {
    const result = evaluateSheetFormulas([cell(0, 0, "=B1"), cell(0, 1, "=A1")]);

    expect(result.get("0:0")).toMatchObject({
      calcValue: "#CIRC",
      dependencies: ["B1"],
      error: "Circular reference",
    });
    expect(result.get("0:1")).toMatchObject({
      calcValue: "#CIRC",
      dependencies: ["A1"],
      error: "Circular reference",
    });
  });

  it("reports unsupported formulas", () => {
    const result = evaluateSheetFormulas([cell(0, 0, '=CONCAT("a","b")')]);

    expect(result.get("0:0")).toMatchObject({
      calcValue: "#VALUE!",
      dependencies: [],
      error: "Unsupported formula",
    });
  });

  it("evaluates scalar QUERY selects with headers, where, and limit", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "Region"),
      cell(0, 1, "ARR"),
      cell(1, 0, "North"),
      cell(1, 1, "10"),
      cell(2, 0, "South"),
      cell(2, 1, "20"),
      cell(3, 0, "North"),
      cell(3, 1, "30"),
      cell(4, 0, "=QUERY(A1:B4, \"select B where A = 'North' limit 1\", 1)"),
    ]);

    expect(result.get("4:0")).toMatchObject({
      calcValue: "10",
      dependencies: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"],
      error: null,
    });
  });

  it("evaluates scalar QUERY ordering before limit", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "Region"),
      cell(0, 1, "ARR"),
      cell(1, 0, "North"),
      cell(1, 1, "10"),
      cell(2, 0, "South"),
      cell(2, 1, "20"),
      cell(3, 0, "North"),
      cell(3, 1, "30"),
      cell(4, 0, '=QUERY(A1:B4, "select A where B >= 10 order by B desc limit 1", 1)'),
      cell(4, 1, '=QUERY(A1:B4, "select B order by A asc limit 1", 1)'),
    ]);

    expect(result.get("4:0")).toMatchObject({
      calcValue: "North",
      error: null,
    });
    expect(result.get("4:1")).toMatchObject({
      calcValue: "10",
      error: null,
    });
  });

  it("reports QUERY ordering columns outside the source range", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "10"),
      cell(0, 1, '=QUERY(A1:A1, "select A order by B", 0)'),
    ]);

    expect(result.get("0:1")).toMatchObject({
      calcValue: "#VALUE!",
      error: "QUERY column is outside the source range",
    });
  });

  it("evaluates scalar QUERY aggregates with relative columns and numeric predicates", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "Region"),
      cell(0, 1, "ARR"),
      cell(1, 0, "North"),
      cell(1, 1, "10"),
      cell(2, 0, "South"),
      cell(2, 1, "20"),
      cell(3, 0, "North"),
      cell(3, 1, "30"),
      cell(4, 0, "=QUERY(A1:B4, \"select sum(Col2) where Col1 = 'North'\", 1)"),
      cell(4, 1, '=QUERY(A1:B4, "select count(*) where B >= 20", 1)'),
    ]);

    expect(result.get("4:0")).toMatchObject({
      calcValue: "40",
      error: null,
    });
    expect(result.get("4:1")).toMatchObject({
      calcValue: "2",
      error: null,
    });
  });

  it("evaluates scalar QUERY contains predicates case-insensitively", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "Account"),
      cell(0, 1, "ARR"),
      cell(1, 0, "Acme Expansion"),
      cell(1, 1, "10"),
      cell(2, 0, "Bravo Renewal"),
      cell(2, 1, "20"),
      cell(3, 0, "North Expansion"),
      cell(3, 1, "30"),
      cell(4, 0, "=QUERY(A1:B4, \"select sum(B) where A contains 'expansion'\", 1)"),
      cell(4, 1, "=HELIX.QUERY(A1:B4, \"select count(*) where Col1 contains 'RENEW'\", 1)"),
    ]);

    expect(result.get("4:0")).toMatchObject({
      calcValue: "40",
      dependencies: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"],
      error: null,
    });
    expect(result.get("4:1")).toMatchObject({
      calcValue: "1",
      dependencies: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"],
      error: null,
    });
  });

  it("reports unsupported QUERY syntax", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "10"),
      cell(0, 1, '=QUERY(A1:A1, "select A group by A", 0)'),
    ]);

    expect(result.get("0:1")).toMatchObject({
      calcValue: "#VALUE!",
      dependencies: [],
      error: "Unsupported QUERY formula",
    });
  });

  it("evaluates first-pass HELIX extension functions", () => {
    const result = evaluateSheetFormulas(
      [
        cell(0, 0, "Region"),
        cell(0, 1, "ARR"),
        cell(1, 0, "North"),
        cell(1, 1, "10"),
        cell(2, 0, "South"),
        cell(2, 1, "20"),
        cell(3, 0, '=HELIX.QUERY(A1:B3, "select sum(B)", 1)'),
        cell(3, 1, '=HELIX.AI.CLASSIFY("renewal expansion risk", "Expansion, Renewal, Risk")'),
        cell(3, 2, '=HELIX.AI.CLASSIFY(A2, "South, North")'),
        cell(3, 3, '=HELIX.DRIVE.LIST("roadmap")'),
      ],
      {
        driveEntries: [
          { name: "roadmap.pdf", path: "/Strategy/roadmap.pdf", mimeType: "application/pdf" },
          { name: "budget.xlsx", path: "/Finance/budget.xlsx" },
        ],
      },
    );

    expect(result.get("3:0")).toMatchObject({
      calcValue: "30",
      dependencies: ["A1", "A2", "A3", "B1", "B2", "B3"],
      error: null,
    });
    expect(result.get("3:1")).toMatchObject({
      calcValue: "Expansion",
      dependencies: [],
      error: null,
    });
    expect(result.get("3:2")).toMatchObject({
      calcValue: "North",
      dependencies: ["A2"],
      error: null,
    });
    expect(result.get("3:3")).toMatchObject({
      calcValue: "roadmap.pdf",
      dependencies: [],
      error: null,
    });
  });

  it("propagates reference errors from QUERY source ranges", () => {
    const result = evaluateSheetFormulas([
      cell(0, 0, "=B1"),
      cell(0, 1, "=A1"),
      cell(0, 2, '=QUERY(A1:B1, "select count(*)", 0)'),
    ]);

    expect(result.get("0:2")).toMatchObject({
      calcValue: "#CIRC",
      dependencies: ["A1", "B1"],
      error: "Circular reference",
    });
  });
});

function cell(row: number, col: number, value: string) {
  return { row, col, value };
}

function tabCell(sheetTabId: string, row: number, col: number, value: string) {
  return { sheetTabId, row, col, value };
}
