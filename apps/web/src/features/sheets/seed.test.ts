import { describe, expect, it } from "vitest";
import { cellReference, columnLetter, parseCurrency, sumArr } from "./seed";

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
  it("skips the header row", () => {
    const grid = [
      ["Customer", "ARR"],
      ["A", "$100"],
      ["B", "$200"],
    ];
    expect(sumArr(grid)).toBe(300);
  });

  it("treats non-numeric cells as zero", () => {
    const grid = [
      ["Customer", "ARR"],
      ["A", "$100"],
      ["B", "n/a"],
    ];
    expect(sumArr(grid)).toBe(100);
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
