import type { JsonObject } from "@helix/sdk-types";
import { outboundFetch } from "../../outbound-http.js";
import type { VectorMatch } from "./types.js";

export interface HttpVectorAdapterConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

export interface NormalizedHttpVectorConfig {
  readonly baseUrl: URL;
  readonly apiKey?: string;
  readonly fetch: typeof fetch;
}

export class VectorHttpError extends Error {
  constructor(
    readonly adapterId: string,
    readonly status: number,
  ) {
    super(`${adapterId} vector request failed with HTTP ${String(status)}`);
    this.name = "VectorHttpError";
  }
}

export function normalizeHttpConfig(config: HttpVectorAdapterConfig): NormalizedHttpVectorConfig {
  if (config.baseUrl.trim().length === 0) {
    throw new TypeError("Vector adapter baseUrl is required");
  }

  return {
    baseUrl: new URL(config.baseUrl),
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    fetch: config.fetch ?? outboundFetch,
  };
}

export async function requestJson(
  adapterId: string,
  config: NormalizedHttpVectorConfig,
  method: "DELETE" | "GET" | "POST" | "PUT",
  path: string,
  body?: JsonObject,
): Promise<unknown> {
  const url = new URL(path, config.baseUrl);
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
  };
  const response = await config.fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new VectorHttpError(adapterId, response.status);
  }
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalJsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalVector(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const numbers = value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
  return numbers.length === value.length ? numbers : undefined;
}

export function withOptionalFields(match: {
  readonly id: string;
  readonly score: number;
  readonly metadata?: JsonObject | undefined;
  readonly vector?: readonly number[] | undefined;
}): VectorMatch {
  return {
    id: match.id,
    score: match.score,
    ...(match.metadata === undefined ? {} : { metadata: match.metadata }),
    ...(match.vector === undefined ? {} : { vector: match.vector }),
  };
}
