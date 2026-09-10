import { expect, it } from "vitest";
import { isJsonRecord, isJsonValue } from "@helix/sdk-types";
import { parseBasicAuthorization } from "./http-auth.js";
import { compactJsonObject, parseJsonObject, toJsonObject } from "./json.js";
import { isUniqueViolation, toSqlJson } from "./sql.js";
import { hasControlCharacter } from "./strings.js";

it("preserves JSON serialization, credential parsing and shared validation boundaries", () => {
  expect(toSqlJson({ at: new Date("2026-01-01Z"), unset: undefined })).toEqual({
    at: "2026-01-01T00:00:00.000Z",
  });
  expect(toJsonObject({ nested: [null, true] })).toEqual({ nested: [null, true] });
  expect(compactJsonObject({ unset: undefined, nil: null })).toEqual({ nil: null });
  expect(parseJsonObject("[1]")).toBeUndefined();
  expect(parseJsonObject("{")).toBeUndefined();
  expect(isJsonRecord({ nested: [null, 3] })).toBe(true);
  expect(isJsonValue({ nested: [undefined] })).toBe(false);
  expect(isJsonValue(Infinity)).toBe(false);
  expect(
    parseBasicAuthorization(`Basic ${Buffer.from("name:secret:with:colons").toString("base64")}`),
  ).toEqual({ username: "name", password: "secret:with:colons" });
  expect(parseBasicAuthorization("Bearer token")).toBeNull();
  expect(isUniqueViolation({ code: "23505" })).toBe(true);
  expect(isUniqueViolation(null)).toBe(false);
  expect(hasControlCharacter("bad\u0000")).toBe(true);
  expect(hasControlCharacter("valid name")).toBe(false);
});
