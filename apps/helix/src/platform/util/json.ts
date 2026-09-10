import type { JsonObject } from "@helix/sdk-types";
export { isJsonObject as isRecord } from "@helix/sdk-types";

export function toJsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

export function compactJsonObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  ) as JsonObject;
}
