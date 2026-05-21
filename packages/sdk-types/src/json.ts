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
