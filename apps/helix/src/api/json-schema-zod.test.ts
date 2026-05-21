import { describe, expect, it } from "vitest";
import { jsonSchemaToZod } from "./json-schema-zod.js";

describe("jsonSchemaToZod", () => {
  it("converts object schemas with required and optional properties", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      additionalProperties: false,
      required: ["to"],
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
      },
    });

    expect(schema.parse({ to: "a@example.com" })).toEqual({ to: "a@example.com" });
    expect(() => {
      schema.parse({});
    }).toThrow();
    expect(() => {
      schema.parse({ to: "a", extra: 1 });
    }).toThrow();
  });

  it("converts primitive, array, and enum schemas", () => {
    expect(jsonSchemaToZod({ type: "integer" }).parse(3)).toBe(3);
    expect(() => {
      jsonSchemaToZod({ type: "integer" }).parse(3.5);
    }).toThrow();
    expect(jsonSchemaToZod({ type: "array", items: { type: "string" } }).parse(["x"])).toEqual([
      "x",
    ]);
    expect(jsonSchemaToZod({ enum: ["a", "b"] }).parse("b")).toBe("b");
    expect(() => {
      jsonSchemaToZod({ enum: ["a", "b"] }).parse("c");
    }).toThrow();
  });

  it("falls back to permissive validation for schemas without a type", () => {
    const schema = jsonSchemaToZod({});
    expect(schema.parse({ anything: true })).toEqual({ anything: true });
    expect(schema.parse("string")).toBe("string");
  });

  it("converts anyOf into a union", () => {
    const schema = jsonSchemaToZod({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(schema.parse("x")).toBe("x");
    expect(schema.parse(5)).toBe(5);
    expect(() => {
      schema.parse(true);
    }).toThrow();
  });
});
