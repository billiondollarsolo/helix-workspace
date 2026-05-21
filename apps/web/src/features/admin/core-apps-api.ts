import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

/**
 * Core-app enablement client.
 *
 * Core apps (mail, chat, drive, docs, calendar, meet, assistant) are toggleable
 * platform modules. This module talks to two backend surfaces:
 *  - `/api/core-apps` — readable by any authenticated user; drives the web
 *    shell's left-rail + route gating;
 *  - `/api/admin/core-apps` — admin-only view/toggle of org-wide enablement.
 */

export const CORE_APP_IDS = [
  "mail",
  "chat",
  "drive",
  "docs",
  "calendar",
  "meet",
  "assistant",
] as const;

export type CoreAppId = (typeof CORE_APP_IDS)[number];

/** Shell-facing core-app projection (non-admin). */
export interface CoreAppShellEntry {
  readonly id: CoreAppId;
  readonly name: string;
  readonly enabled: boolean;
  /** True iff served by this deployment (enabled AND in the booting role). */
  readonly registered: boolean;
}

export interface CoreAppShellStatus {
  readonly role: string;
  readonly apps: readonly CoreAppShellEntry[];
}

/** Admin-facing core-app view. */
export interface CoreAppAdminEntry {
  readonly id: CoreAppId;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly inRole: boolean;
  readonly registered: boolean;
}

export interface CoreAppsAdminStatus {
  readonly role: string;
  readonly apps: readonly CoreAppAdminEntry[];
}

export interface CoreAppToggleResult extends CoreAppsAdminStatus {
  readonly changed: {
    readonly appId: CoreAppId;
    readonly from: boolean;
    readonly to: boolean;
    readonly requiresRestart: boolean;
  };
}

const jsonHeaders = { "content-type": "application/json" } as const;

// ---------------------------------------------------------------------------
// Response schemas.
//
// The backend responses are validated at the trust boundary with Zod so that a
// malformed payload (e.g. `{}`, a stray HTML error page parsed as JSON, or a
// future backend change) can never reach the React tree as an `undefined`
// `apps` array and white-screen the entire shell. Validation failures fail
// safe via `parseResponse`'s caller-supplied fallback.
// ---------------------------------------------------------------------------

const coreAppIdSchema = z.enum(CORE_APP_IDS);

const coreAppShellEntrySchema = z.object({
  id: coreAppIdSchema,
  name: z.string(),
  enabled: z.boolean(),
  registered: z.boolean(),
});

const coreAppShellStatusSchema = z.object({
  role: z.string(),
  apps: z.array(coreAppShellEntrySchema),
});

const coreAppAdminEntrySchema = z.object({
  id: coreAppIdSchema,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  inRole: z.boolean(),
  registered: z.boolean(),
});

const coreAppsAdminStatusSchema = z.object({
  role: z.string(),
  apps: z.array(coreAppAdminEntrySchema),
});

const coreAppToggleResultSchema = coreAppsAdminStatusSchema.extend({
  changed: z.object({
    appId: coreAppIdSchema,
    from: z.boolean(),
    to: z.boolean(),
    requiresRestart: z.boolean(),
  }),
});

/**
 * Well-formed empty shell status. Returned when `/api/core-apps` is malformed
 * so the shell never observes an `undefined` `apps` array. An empty `apps`
 * list is treated by the shell as "no gating info" and shows all rail items,
 * consistent with the in-flight behavior.
 */
const EMPTY_SHELL_STATUS: CoreAppShellStatus = { role: "unknown", apps: [] };

export const coreAppsQueryKeys = {
  shell: () => ["core-apps", "shell"] as const,
  admin: () => ["admin", "core-apps"] as const,
};

/** Query options for the shell's enabled-app set. */
export function coreAppsShellQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: coreAppsQueryKeys.shell(),
    queryFn: () => fetchCoreAppsShellStatus(fetchImpl),
    retry: false,
    staleTime: 60_000,
    throwOnError: false,
  });
}

export function coreAppsAdminQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: coreAppsQueryKeys.admin(),
    queryFn: () => fetchCoreAppsAdminStatus(fetchImpl),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

export async function fetchCoreAppsShellStatus(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<CoreAppShellStatus> {
  const response = await fetchImpl("/api/core-apps", { method: "GET" });
  // Fail safe: a malformed `/api/core-apps` body must never crash the shell.
  // We surface a well-formed empty status instead, which the shell tolerates.
  return parseResponse(response, "load core apps", coreAppShellStatusSchema, EMPTY_SHELL_STATUS);
}

export async function fetchCoreAppsAdminStatus(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<CoreAppsAdminStatus> {
  const response = await fetchImpl("/api/admin/core-apps", { method: "GET" });
  return parseResponse(response, "load core-app settings", coreAppsAdminStatusSchema);
}

export async function setCoreAppEnabled(
  appId: CoreAppId,
  enabled: boolean,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<CoreAppToggleResult> {
  const response = await fetchImpl(`/api/admin/core-apps/${encodeURIComponent(appId)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled }),
  });
  return parseResponse(response, "update core app", coreAppToggleResultSchema);
}

/**
 * Parse and validate a backend response against a Zod schema.
 *
 * - On a non-OK HTTP status: throws with the backend error message.
 * - On a malformed-but-OK body: if `fallback` is provided, returns it (fail
 *   safe); otherwise throws so the caller's query surfaces an error state.
 */
async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
  fallback?: T,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

function errorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return undefined;
}
