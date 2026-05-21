import { describe, expect, it } from "vitest";
import { validateDimension, validateLimit, validateVector, vectorToPgLiteral } from "./types.js";

describe("vector type helpers", () => {
  it("validates finite vectors and serializes pgvector literals", () => {
    expect(validateVector([0.1, 0.2], 2)).toEqual([0.1, 0.2]);
    expect(vectorToPgLiteral([0.1, 0.2])).toBe("[0.1,0.2]");
  });

  it("rejects invalid dimensions and limits", () => {
    expect(() => validateVector([1], 2)).toThrow("does not match");
    expect(() => validateVector([Number.NaN])).toThrow("finite");
    expect(() => validateDimension(0)).toThrow("positive");
    expect(() => validateLimit(0)).toThrow("positive");
  });
});

