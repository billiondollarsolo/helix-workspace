import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

/**
 * Admin Console — OAuth apps client.
 *
 * Talks to `/api/admin/oauth-apps` — third-party OAuth app registrations the
 * org has encountered. Supports a paginated/filterable list, single fetch,
 * registration, status change (approve / block / pending), and revoke.
 *
 * Backend responses are validated at the trust boundary with Zod.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export const OAUTH_APP_RISKS = ["low", "medium", "high"] as const;
export type OAuthAppRisk = (typeof OAUTH_APP_RISKS)[number];

export const OAUTH_APP_STATUSES = ["approved", "pending", "blocked", "revoked"] as const;
export type OAuthAppStatus = (typeof OAUTH_APP_STATUSES)[number];

/** Statuses settable via PATCH …/status (revoked is terminal, via /revoke). */
export const OAUTH_APP_SETTABLE_STATUSES = ["approved", "pending", "blocked"] as const;
export type OAuthAppSettableStatus = (typeof OAUTH_APP_SETTABLE_STATUSES)[number];

const oauthAppSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  clientId: z.string().nullable(),
  publisher: z.string(),
  scopes: z.array(z.string()),
  scopeSummary: z.string(),
  risk: z.enum(OAUTH_APP_RISKS),
  status: z.enum(OAUTH_APP_STATUSES),
  userCount: z.number().int(),
  firstAuthorizedAt: z.string().nullable(),
  lastAuthorizedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OAuthApp = z.infer<typeof oauthAppSchema>;

const oauthAppsResponseSchema = z.object({
  apps: z.array(oauthAppSchema),
  nextCursor: z.string().nullable(),
});

export type OAuthAppsResponse = z.infer<typeof oauthAppsResponseSchema>;

const oauthAppResponseSchema = z.object({ app: oauthAppSchema });

export interface OAuthAppsQueryInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly status?: OAuthAppStatus;
  readonly risk?: OAuthAppRisk;
  readonly query?: string;
}

export interface CreateOAuthAppInput {
  readonly name: string;
  readonly clientId?: string | null;
  readonly publisher?: string;
  readonly scopes?: readonly string[];
  readonly scopeSummary?: string;
  readonly risk?: OAuthAppRisk;
  readonly status?: OAuthAppStatus;
  readonly userCount?: number;
}

export const defaultOAuthAppsInput = { limit: 50 } as const satisfies OAuthAppsQueryInput;

// ---------------------------------------------------------------------------
// Query keys + options
// ---------------------------------------------------------------------------

export const oauthAppsQueryKeys = {
  all: () => ["admin", "oauth-apps"] as const,
  list: (input: OAuthAppsQueryInput = defaultOAuthAppsInput) =>
    [
      "admin",
      "oauth-apps",
      input.limit ?? defaultOAuthAppsInput.limit,
      input.cursor ?? "",
      input.status ?? "",
      input.risk ?? "",
      input.query?.trim() ?? "",
    ] as const,
};

export function oauthAppsQueryOptions(
  input: OAuthAppsQueryInput = defaultOAuthAppsInput,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: oauthAppsQueryKeys.list(input),
    queryFn: () => fetchOAuthApps(input, fetchImpl),
  });
}

// ---------------------------------------------------------------------------
// Fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchOAuthApps(
  input: OAuthAppsQueryInput = defaultOAuthAppsInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OAuthAppsResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? defaultOAuthAppsInput.limit));
  appendParam(params, "cursor", input.cursor);
  appendParam(params, "status", input.status);
  appendParam(params, "risk", input.risk);
  appendParam(params, "query", input.query);
  const response = await fetchImpl(`/api/admin/oauth-apps?${params.toString()}`, {
    method: "GET",
  });
  return parseResponse(response, "load OAuth apps", oauthAppsResponseSchema);
}

export async function fetchOAuthApp(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OAuthApp> {
  const response = await fetchImpl(`/api/admin/oauth-apps/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  return (await parseResponse(response, "load OAuth app", oauthAppResponseSchema)).app;
}

export async function createOAuthApp(
  input: CreateOAuthAppInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OAuthApp> {
  const response = await fetchImpl("/api/admin/oauth-apps", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "register OAuth app", oauthAppResponseSchema)).app;
}

export async function setOAuthAppStatus(
  id: string,
  status: OAuthAppSettableStatus,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OAuthApp> {
  const response = await fetchImpl(`/api/admin/oauth-apps/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ status }),
  });
  return (await parseResponse(response, "update OAuth app status", oauthAppResponseSchema)).app;
}

export async function revokeOAuthApp(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OAuthApp> {
  const response = await fetchImpl(`/api/admin/oauth-apps/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    headers: jsonHeaders,
  });
  return (await parseResponse(response, "revoke OAuth app", oauthAppResponseSchema)).app;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
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
