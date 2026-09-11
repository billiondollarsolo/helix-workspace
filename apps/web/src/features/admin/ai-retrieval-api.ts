import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";
import { ADMIN_QUERY_DEFAULTS } from "./console/request-budget";

interface AIRetrievalStatus {
  readonly vector: {
    readonly enabled: boolean;
    readonly backend: string | null;
    readonly embeddingModel: string | null;
    readonly dimensions: number | null;
    readonly collection: string | null;
    readonly maxInputChars?: number;
    readonly chunkOverlapChars?: number;
    readonly chunkedDocuments?: number;
  };
  readonly web: { readonly enabled: boolean };
}
interface AIRetrievalTestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly checkedAt: string;
}
interface ReindexJob {
  readonly id: string;
  readonly status: string;
  readonly phase: string;
  readonly totalDocuments: string;
  readonly lastError?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
async function read<T>(
  path: string,
  guard: (value: unknown) => value is T,
  body?: unknown,
): Promise<T> {
  const response = await authenticatedFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw responseError(
      response,
      output,
      "Retrieval request",
      `Retrieval request failed (${String(response.status)}). Try again.`,
    );
  if (!guard(output)) throw new Error("Retrieval request returned an invalid result. Try again.");
  return output;
}
function isJob(value: unknown): value is ReindexJob {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    typeof value.phase === "string" &&
    typeof value.totalDocuments === "string" &&
    (value.lastError === undefined || typeof value.lastError === "string")
  );
}
export function aiRetrievalStatusQueryOptions() {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: ["admin", "ai-retrieval", "status"],
    queryFn: () =>
      read(
        "/api/admin/ai-retrieval/status",
        (value): value is AIRetrievalStatus =>
          record(value) &&
          record(value.vector) &&
          typeof value.vector.enabled === "boolean" &&
          (value.vector.backend === null || typeof value.vector.backend === "string") &&
          (value.vector.embeddingModel === null ||
            typeof value.vector.embeddingModel === "string") &&
          (value.vector.dimensions === null || typeof value.vector.dimensions === "number") &&
          (value.vector.collection === null || typeof value.vector.collection === "string") &&
          (value.vector.maxInputChars === undefined ||
            (typeof value.vector.maxInputChars === "number" &&
              Number.isInteger(value.vector.maxInputChars) &&
              value.vector.maxInputChars > 0)) &&
          (value.vector.chunkOverlapChars === undefined ||
            (typeof value.vector.chunkOverlapChars === "number" &&
              Number.isInteger(value.vector.chunkOverlapChars) &&
              value.vector.chunkOverlapChars >= 0 &&
              (typeof value.vector.maxInputChars !== "number" ||
                value.vector.chunkOverlapChars < value.vector.maxInputChars))) &&
          (value.vector.chunkedDocuments === undefined ||
            (typeof value.vector.chunkedDocuments === "number" &&
              Number.isInteger(value.vector.chunkedDocuments) &&
              value.vector.chunkedDocuments >= 0)) &&
          record(value.web) &&
          typeof value.web.enabled === "boolean",
      ),
  });
}
export function reindexJobQueryOptions(id: string | null) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: ["admin", "ai-retrieval", "reindex", id],
    enabled: id !== null,
    queryFn: () => read(`/api/admin/search/reindex/jobs/${encodeURIComponent(id ?? "")}`, isJob),
    // Durable indexing has no realtime emitter; poll only while this job is running.
    refetchInterval: (query) =>
      query.state.error ||
      ["completed", "dead_lettered", "cancelled"].includes(query.state.data?.status ?? "")
        ? false
        : 2_000,
  });
}
export function startAIRetrievalReindex(): Promise<ReindexJob> {
  return read("/api/admin/ai-retrieval/reindex", isJob, {});
}
export function cancelAIRetrievalReindex(id: string): Promise<{ readonly status: "cancelled" }> {
  return read(
    `/api/admin/search/reindex/jobs/${encodeURIComponent(id)}/cancel`,
    (value): value is { status: "cancelled" } => record(value) && value.status === "cancelled",
    {},
  );
}
export function testAIRetrieval(target: "vector" | "web"): Promise<AIRetrievalTestResult> {
  return read(
    "/api/admin/ai-retrieval/test",
    (value): value is AIRetrievalTestResult =>
      record(value) &&
      typeof value.ok === "boolean" &&
      typeof value.message === "string" &&
      typeof value.latencyMs === "number" &&
      typeof value.checkedAt === "string",
    { target },
  );
}
