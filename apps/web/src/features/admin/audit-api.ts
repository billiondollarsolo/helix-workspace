/* Admin audit log data access: `GET /api/admin/audit-log`, filtered on the
 * server by actor, event, object, outcome and date range, newest first, with
 * keyset cursor paging. */

import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditLogRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly traceId: string | null;
  readonly payload: Record<string, unknown>;
  readonly prevHash: string | null;
  readonly thisHash: string;
  readonly createdAt: string;
  readonly outcome: AuditOutcome;
}

export interface AuditLogListResponse {
  readonly records: readonly AuditLogRecord[];
  readonly nextCursor: string | null;
}

export interface AuditLogQueryInput {
  readonly actorId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly objectId?: string;
  readonly objectType?: string;
  readonly outcome?: AuditOutcome;
  /** ISO timestamp, inclusive. */
  readonly since?: string;
  /** ISO timestamp, exclusive. */
  readonly until?: string;
  readonly verb?: string;
}

export const defaultAuditLogInput = {
  limit: 50,
} as const satisfies AuditLogQueryInput;

export const adminAuditLogQueryKeys = {
  list: (input: AuditLogQueryInput = defaultAuditLogInput) =>
    [
      "admin",
      "audit-log",
      input.limit ?? defaultAuditLogInput.limit,
      input.cursor ?? "",
      input.actorId?.trim() ?? "",
      input.objectId?.trim() ?? "",
      input.objectType?.trim() ?? "",
      input.verb?.trim() ?? "",
      input.outcome ?? "",
      input.since ?? "",
      input.until ?? "",
    ] as const,
};

export function adminAuditLogQueryOptions(input: AuditLogQueryInput = defaultAuditLogInput) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: adminAuditLogQueryKeys.list(input),
    queryFn: () => listAuditLog(input),
    /* The record of what happened: an administrator opens it to check whether
       something just did, so a cached page is never served as current. */
    staleTime: 0,
  });
}

export async function listAuditLog(
  input: AuditLogQueryInput = defaultAuditLogInput,
): Promise<AuditLogListResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? defaultAuditLogInput.limit));
  appendParam(params, "actorId", input.actorId);
  appendParam(params, "cursor", input.cursor);
  appendParam(params, "objectId", input.objectId);
  appendParam(params, "objectType", input.objectType);
  appendParam(params, "outcome", input.outcome);
  appendParam(params, "since", input.since);
  appendParam(params, "until", input.until);
  appendParam(params, "verb", input.verb);

  const response = await authenticatedFetch(`/api/admin/audit-log?${params.toString()}`);
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `Audit log failed with ${String(response.status)}`,
    );
  }
  if (!isAuditLogListResponse(output)) {
    throw new Error("Audit log response was missing required fields.");
  }
  return output;
}

/** "tool.invocation.executed" → "Tool invocation executed". */
export function readableEvent(verb: string): string {
  const words = verb
    .split(/[._]+/u)
    .filter((word) => word.length > 0)
    .join(" ");
  return words.length === 0 ? verb : words.charAt(0).toUpperCase() + words.slice(1);
}

function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

function isAuditLogListResponse(value: unknown): value is AuditLogListResponse {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return false;
  }
  return (
    value.records.every(isAuditLogRecord) &&
    (typeof value.nextCursor === "string" || value.nextCursor === null)
  );
}

const OUTCOMES: readonly string[] = ["success", "failure", "denied"];

function isAuditLogRecord(value: unknown): value is AuditLogRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.orgId === "string" &&
    (typeof value.actorId === "string" || value.actorId === null) &&
    typeof value.verb === "string" &&
    typeof value.objectType === "string" &&
    (typeof value.objectId === "string" || value.objectId === null) &&
    (typeof value.traceId === "string" || value.traceId === null) &&
    isRecord(value.payload) &&
    (typeof value.prevHash === "string" || value.prevHash === null) &&
    typeof value.thisHash === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.outcome === "string" &&
    OUTCOMES.includes(value.outcome)
  );
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
