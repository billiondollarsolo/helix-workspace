import { describe, expect, it } from "vitest";
import {
  loadNegativeMatrixFromDisk,
  parseNegativeMatrixMarkdown,
  REQUIRED_NEGATIVE_MATRIX_DOMAINS,
} from "./negative-matrix.js";

describe("negative-matrix scaffold (G1.9)", () => {
  it("loads the on-disk matrix with required columns and core domains", () => {
    const cases = loadNegativeMatrixFromDisk();
    expect(cases.length).toBeGreaterThanOrEqual(REQUIRED_NEGATIVE_MATRIX_DOMAINS.length);
    const domains = new Set(cases.map((entry) => entry.domain));
    for (const domain of REQUIRED_NEGATIVE_MATRIX_DOMAINS) {
      expect(domains.has(domain)).toBe(true);
    }
    for (const entry of cases) {
      expect(entry.expected.toLowerCase()).toMatch(/deny|pending|refuse|403|error/);
    }
  });

  it("rejects tables missing required columns", () => {
    expect(() =>
      parseNegativeMatrixMarkdown(`
| Domain | Actor |
| --- | --- |
| mail | x |
`),
    ).toThrow(/missing required column/);
  });
});
