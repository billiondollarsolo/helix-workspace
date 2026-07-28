import { describe, expect, it } from "vitest";
import {
  optionalBooleanSearchParam,
  optionalEnumSearchParam,
  optionalIsoDateSearchParam,
  optionalRawStringSearchParam,
  optionalStringSearchParam,
  optionalUuidSearchParam,
  stringSearchParam,
} from "./search-params";

describe("search parameter parsing", () => {
  it("normalizes optional strings without coercing other values", () => {
    expect(optionalStringSearchParam("  hello  ")).toBe("hello");
    expect(optionalStringSearchParam("   ")).toBeUndefined();
    expect(optionalStringSearchParam(42)).toBeUndefined();
    expect(stringSearchParam(" https://example.test/callback ")).toBe(
      " https://example.test/callback ",
    );
    expect(optionalRawStringSearchParam(" opaque state ")).toBe(" opaque state ");
    expect(stringSearchParam(undefined, "fallback")).toBe("fallback");
  });

  it("accepts only explicit boolean flags, enum values, UUIDs, and real ISO dates", () => {
    expect(optionalBooleanSearchParam("1")).toBe(true);
    expect(optionalBooleanSearchParam("false")).toBeUndefined();
    expect(optionalEnumSearchParam("month", ["day", "week", "month"])).toBe("month");
    expect(optionalEnumSearchParam("year", ["day", "week", "month"])).toBeUndefined();
    expect(optionalUuidSearchParam("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(optionalUuidSearchParam("not-a-uuid")).toBeUndefined();
    expect(optionalIsoDateSearchParam("2024-02-29")).toBe("2024-02-29");
    expect(optionalIsoDateSearchParam("2023-02-29")).toBeUndefined();
  });
});
