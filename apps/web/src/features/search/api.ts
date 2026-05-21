import { authenticatedFetch } from "@/lib/auth";

export type GlobalSearchType = "mail" | "chat" | "docs" | "drive" | "calendar";

export interface GlobalSearchHit {
  readonly id: string;
  readonly type: GlobalSearchType;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly attributes?: Record<string, unknown>;
  readonly updatedAt?: string;
  readonly score?: number;
  readonly highlights?: Record<string, unknown>;
}

export interface GlobalSearchResponse {
  readonly hits: readonly GlobalSearchHit[];
  readonly query: string;
  readonly estimatedTotalHits?: number;
  readonly processingTimeMs?: number;
}

export interface GlobalSearchInput {
  readonly query: string;
  readonly types?: readonly GlobalSearchType[];
  readonly limit?: number;
  readonly offset?: number;
}

export type GlobalSearchApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function searchGlobal(
  input: GlobalSearchInput,
  fetchImpl: GlobalSearchApiFetch = authenticatedFetch,
): Promise<GlobalSearchResponse> {
  const query = input.query.trim();
  if (query.length === 0) {
    return { hits: [], query };
  }

  const output = await callSearchTool<{
    readonly hits?: readonly unknown[];
    readonly query?: string;
    readonly estimatedTotalHits?: number;
    readonly processingTimeMs?: number;
  }>(
    "search.query",
    {
      query,
      ...(input.types === undefined ? {} : { types: input.types }),
      limit: input.limit ?? 10,
      offset: input.offset ?? 0,
    },
    fetchImpl,
  );

  return {
    hits: (output.hits ?? []).filter(isGlobalSearchHit),
    query: typeof output.query === "string" ? output.query : query,
    ...(typeof output.estimatedTotalHits === "number"
      ? { estimatedTotalHits: output.estimatedTotalHits }
      : {}),
    ...(typeof output.processingTimeMs === "number"
      ? { processingTimeMs: output.processingTimeMs }
      : {}),
  };
}

async function callSearchTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: GlobalSearchApiFetch,
): Promise<Output> {
  const response = await fetchImpl(`/api/tools/${toolId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `${toolId} failed with ${String(response.status)}`,
    );
  }

  return output as Output;
}

function isGlobalSearchHit(value: unknown): value is GlobalSearchHit {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isGlobalSearchType(value.type) &&
    optionalString(value.title) &&
    optionalString(value.body) &&
    optionalString(value.url) &&
    optionalString(value.updatedAt) &&
    (value.attributes === undefined || isRecord(value.attributes)) &&
    (value.highlights === undefined || isRecord(value.highlights)) &&
    (value.score === undefined || typeof value.score === "number")
  );
}

function isGlobalSearchType(value: unknown): value is GlobalSearchType {
  return (
    value === "mail" ||
    value === "chat" ||
    value === "docs" ||
    value === "drive" ||
    value === "calendar"
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
