/* Validated security tier configuration transport. */

import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";
import type {
  PlatformConfigPatch,
  PlatformConfigStatus,
  TierId,
} from "@/features/admin/tier-readiness/types";

export const adminPlatformConfigQueryKey = ["admin", "platform-config"] as const;

export function adminPlatformConfigQueryOptions() {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: adminPlatformConfigQueryKey,
    queryFn: fetchPlatformConfigStatus,
    staleTime: 30_000,
  });
}

interface AdminReadinessRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminPlatformConfigQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminReadinessQueries(queryClient: AdminReadinessRouteQueryClient) {
  await queryClient.ensureQueryData(adminPlatformConfigQueryOptions()).catch(() => undefined);
}

async function readValidated<T>(
  response: Response,
  guard: (value: unknown) => value is T,
  subject: string,
  verb = "request",
  missingSubject = subject,
): Promise<T> {
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = isRecord(output) && typeof output.error === "string" ? output.error : undefined;
    throw new Error(error ?? `${subject} ${verb} failed with ${String(response.status)}`);
  }
  if (!guard(output)) {
    throw new Error(`${missingSubject} response was missing required fields.`);
  }
  return output;
}

async function fetchPlatformConfigStatus(): Promise<PlatformConfigStatus> {
  const response = await authenticatedFetch("/api/admin/platform-config");
  return readValidated(response, isPlatformConfigStatus, "Platform config");
}

export async function updatePlatformTier(tier: TierId): Promise<PlatformConfigStatus> {
  return patchPlatformConfig({ security: { tier } });
}

/** Persist operator AI / mail spam settings via the platform-config admin API. */
export async function updatePlatformAiSettings(
  ai: NonNullable<PlatformConfigPatch["ai"]>,
): Promise<PlatformConfigStatus> {
  return patchPlatformConfig({ ai });
}

async function patchPlatformConfig(payload: PlatformConfigPatch): Promise<PlatformConfigStatus> {
  const response = await authenticatedFetch("/api/admin/platform-config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readValidated(response, isPlatformConfigStatus, "Platform config", "update");
}
function isPlatformConfigStatus(value: unknown): value is PlatformConfigStatus {
  return (
    isRecord(value) &&
    isRecord(value.config) &&
    isRecord(value.config.security) &&
    isTierId(value.config.security.tier) &&
    isRecord(value.readiness) &&
    typeof value.readiness.ready === "boolean" &&
    Array.isArray(value.readiness.requirements)
  );
}

function isTierId(value: unknown): value is TierId {
  return (
    value === "personal" || value === "business" || value === "enterprise" || value === "sovereign"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
