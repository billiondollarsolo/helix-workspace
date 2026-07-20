import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInput, ContractValidationError } from "./http.js";

const schema = z.object({ name: z.string().min(1) });

describe("parseInput", () => {
  it("returns the parsed value on success", () => {
    expect(parseInput(schema, { name: "ok" })).toEqual({ name: "ok" });
  });

  it("throws ContractValidationError with field details on failure", () => {
    try {
      parseInput(schema, { name: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.code).toBe("bad_request");
      expect(e.issues[0]?.path).toEqual(["name"]);
    }
  });
});
