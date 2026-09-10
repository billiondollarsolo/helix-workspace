export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value;
}

/** A JSON tree, excluding non-finite numbers and runtime-only values. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

export function isJsonRecord(value: unknown): value is JsonObject {
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}
