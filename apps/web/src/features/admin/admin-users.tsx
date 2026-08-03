/* Admin user directory data access. The rendered directory lives in
   `sections/users.tsx` — this module owns the API call, the query key, and the
   `AdminUser` shape that the directory, app passwords, and agent credentials
   surfaces all project from. */

import { authenticatedFetch } from "@/lib/auth";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

export interface AdminUser {
  readonly id: string;
  readonly orgId: string;
  readonly type: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminUsersListResponse {
  readonly users: readonly AdminUser[];
  readonly nextCursor: string | null;
}

export interface AdminUsersQueryInput {
  readonly cursor?: string;
  readonly includeDisabled?: boolean;
  readonly limit?: number;
  readonly query?: string;
  readonly type?: string;
}

export const defaultAdminUsersInput = {
  includeDisabled: false,
  limit: 50,
  query: "",
  type: "",
} as const satisfies AdminUsersQueryInput;

export const adminUsersQueryKeys = {
  list: (input: AdminUsersQueryInput = defaultAdminUsersInput) =>
    [
      "admin",
      "users",
      input.limit ?? defaultAdminUsersInput.limit,
      input.cursor ?? "",
      input.query?.trim() ?? "",
      input.type?.trim() ?? "",
      input.includeDisabled ?? defaultAdminUsersInput.includeDisabled,
    ] as const,
  /* Deliberately a different key space from `list`, and deliberately without
     the cursor: an infinite query caches `{ pages, pageParams }` where a plain
     one caches a single page, and the cursor is the page param rather than part
     of the identity. Sharing a key would hand the audit-log actor picker — which
     reads `list` with the same limit and includeDisabled — a paged object where
     it expects one response. */
  infinite: (input: AdminUsersQueryInput = defaultAdminUsersInput) =>
    [
      "admin",
      "users",
      "infinite",
      input.limit ?? defaultAdminUsersInput.limit,
      input.query?.trim() ?? "",
      input.type?.trim() ?? "",
      input.includeDisabled ?? defaultAdminUsersInput.includeDisabled,
    ] as const,
};

export function adminUsersQueryOptions(input: AdminUsersQueryInput = defaultAdminUsersInput) {
  return queryOptions({
    queryKey: adminUsersQueryKeys.list(input),
    queryFn: () => listAdminUsers(input),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

/** The same endpoint, walked page by page with the route's keyset cursor.
 *
 *  The directory used to fetch one 250-row page and search it in the browser,
 *  which meant a 10k-actor workspace answered "no users match" for anyone
 *  outside the newest 250. `query` and `type` now go to the server (indexed SQL
 *  over email / display name / id) and the rest of the workspace is reachable
 *  by following `nextCursor` instead of being silently dropped. */
export function adminUsersInfiniteQueryOptions(
  input: AdminUsersQueryInput = defaultAdminUsersInput,
) {
  return infiniteQueryOptions({
    queryKey: adminUsersQueryKeys.infinite(input),
    queryFn: ({ pageParam }) =>
      listAdminUsers({ ...input, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

interface AdminUsersRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminUsersQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminUsersQuery(queryClient: AdminUsersRouteQueryClient) {
  await queryClient.ensureQueryData(adminUsersQueryOptions()).catch(() => undefined);
}

export async function listAdminUsers(
  input: AdminUsersQueryInput = defaultAdminUsersInput,
): Promise<AdminUsersListResponse> {
  const params = new URLSearchParams();
  appendParam(params, "query", input.query);
  appendParam(params, "type", input.type);
  params.set(
    "includeDisabled",
    String(input.includeDisabled ?? defaultAdminUsersInput.includeDisabled),
  );
  params.set("limit", String(input.limit ?? defaultAdminUsersInput.limit));
  appendParam(params, "cursor", input.cursor);

  const response = await authenticatedFetch(`/api/admin/users?${params.toString()}`);
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessageFromOutput(output) ?? `Admin users failed with ${response.status}`);
  }
  if (!isAdminUsersListResponse(output)) {
    throw new Error("Admin users response was missing required fields.");
  }
  return output;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

function isAdminUsersListResponse(value: unknown): value is AdminUsersListResponse {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    return false;
  }
  return (
    value.users.every(isAdminUser) &&
    (typeof value.nextCursor === "string" || value.nextCursor === null)
  );
}

function isAdminUser(value: unknown): value is AdminUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.orgId === "string" &&
    typeof value.type === "string" &&
    (typeof value.email === "string" || value.email === null) &&
    typeof value.displayName === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    (typeof value.disabledAt === "string" || value.disabledAt === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
