import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

/** Per-user AI cost limit override as returned by the admin API. */
export interface AICostLimit {
  readonly actorId: string;
  /** Daily per-actor budget in USD, or `null` to use the tier default. */
  readonly actorDailyUsd: number | null;
  /** Daily per-feature budget in USD, or `null` to use the tier default. */
  readonly featureDailyUsd: number | null;
  readonly updatedByActorId: string | null;
  readonly updatedAt: string;
}

export interface AICostTierDefault {
  readonly tier: string;
  readonly actorDailyUsd: number | null;
  readonly featureDailyUsd: number | null;
}

export interface AICostLimitListResponse {
  readonly tierDefault: AICostTierDefault;
  readonly limits: readonly AICostLimit[];
}

export interface AICostLimitUpsertInput {
  readonly actorId: string;
  readonly actorDailyUsd: number | null;
  readonly featureDailyUsd: number | null;
}

const jsonHeaders = { "content-type": "application/json" } as const;

export const aiCostLimitsQueryKeys = {
  list: () => ["admin", "ai-cost-limits"] as const,
};

export function aiCostLimitsQueryOptions() {
  return queryOptions({
    queryKey: aiCostLimitsQueryKeys.list(),
    queryFn: () => listAICostLimits(),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

export async function listAICostLimits(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AICostLimitListResponse> {
  const response = await fetchImpl("/api/admin/ai/cost-limits", { method: "GET" });
  return parseResponse<AICostLimitListResponse>(response, "list AI cost limits");
}

export async function setAICostLimit(
  input: AICostLimitUpsertInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<{ readonly override: AICostLimit }> {
  const response = await fetchImpl(
    `/api/admin/ai/cost-limits/${encodeURIComponent(input.actorId)}`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        actorId: input.actorId,
        actorDailyUsd: input.actorDailyUsd,
        featureDailyUsd: input.featureDailyUsd,
      }),
    },
  );
  return parseResponse<{ readonly override: AICostLimit }>(response, "set AI cost limit");
}

export async function clearAICostLimit(
  actorId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<{ readonly status: "removed" | "not_found" }> {
  const response = await fetchImpl(`/api/admin/ai/cost-limits/${encodeURIComponent(actorId)}`, {
    method: "DELETE",
  });
  return parseResponse<{ readonly status: "removed" | "not_found" }>(
    response,
    "clear AI cost limit",
  );
}

async function parseResponse<T>(response: Response, action: string): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  return payload as T;
}

function errorMessage(payload: unknown): string | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : undefined;
}
