import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

export interface FederationApplication {
  readonly id: string;
  readonly origin: string;
  readonly status: string;
  readonly installationId: string;
  readonly tenantId: string;
  readonly lastSyncedAt: string | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly rotationPending: boolean;
  /** Absent from servers older than private links. */
  readonly connection?: FederationConnection;
}
/** How Workspace's own calls reach the app: privately, or over its public address. */
export interface FederationConnection {
  readonly path: "private" | "public";
  readonly target: string | null;
  readonly source: "discovered" | "manual" | "configured" | null;
  readonly checkedAt: string | null;
  readonly error: string | null;
}
export type FederationRole = "viewer" | "member" | "admin";
export interface FederationAssignment {
  readonly actorId: string;
  readonly role: FederationRole;
  readonly displayName: string;
  readonly email: string | null;
}
export function federationApplicationsQueryOptions() {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: ["admin", "federation-applications"],
    retry: false,
    refetchInterval: 15_000,
    queryFn: async () => {
      const response = await authenticatedFetch("/api/admin/federation-applications");
      if (response.status === 404)
        return { enabled: false, applications: [] as FederationApplication[] };
      if (!response.ok)
        throw responseError(
          response,
          await response.json().catch(() => null),
          "Application connection",
          "Application connections could not be loaded.",
        );
      const result = (await response.json()) as { applications: FederationApplication[] };
      return { ...result, enabled: true };
    },
  });
}
export async function registerFederationApplication(input: {
  id: string;
  origin: string;
  connectionId: string;
  proof: string;
}) {
  const response = await authenticatedFetch("/api/admin/federation-applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok)
    throw responseError(
      response,
      await response.json().catch(() => null),
      "Application connection",
      "The application could not be prepared.",
    );
  return response.json() as Promise<
    FederationApplication & { pairingCode: string; expiresAt: string }
  >;
}
export function federationAssignmentsQueryOptions(appId: string, enabled: boolean) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: ["admin", "federation-applications", appId, "assignments"],
    enabled,
    retry: false,
    refetchInterval: 15_000,
    queryFn: async () => {
      const response = await authenticatedFetch(
        `/api/admin/federation-applications/${encodeURIComponent(appId)}/assignments`,
      );
      if (!response.ok)
        throw responseError(
          response,
          await response.json().catch(() => null),
          "Application connection",
          "Application assignments could not be loaded.",
        );
      return response.json() as Promise<{ revision: string; assignments: FederationAssignment[] }>;
    },
  });
}
export async function setFederationAssignments(
  appId: string,
  assignments: Pick<FederationAssignment, "actorId" | "role">[],
  revision: string,
) {
  const response = await authenticatedFetch(
    `/api/admin/federation-applications/${encodeURIComponent(appId)}/assignments`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignments, revision }),
    },
  );
  if (!response.ok)
    throw responseError(
      response,
      await response.json().catch(() => null),
      "Application connection",
      "Application assignments could not be saved.",
    );
}
export async function revokeFederationApplication(appId: string) {
  const response = await authenticatedFetch(
    `/api/admin/federation-applications/${encodeURIComponent(appId)}`,
    { method: "DELETE" },
  );
  if (!response.ok)
    throw responseError(
      response,
      await response.json().catch(() => null),
      "Application connection",
      "The application could not be disconnected.",
    );
}

export async function rotateFederationCredential(
  appId: string,
  input: { id: string; kind: "oidc" | "scim" | "enrollment" },
) {
  const response = await authenticatedFetch(
    `/api/admin/federation-applications/${encodeURIComponent(appId)}/rotate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok)
    throw responseError(
      response,
      await response.json().catch(() => null),
      "Credential rotation",
      "Credential rotation is pending. Check the connection and retry.",
    );
}

async function privateLinkRequest(
  appId: string,
  method: "PUT" | "DELETE" | "POST",
  body?: { target: string },
): Promise<FederationApplication> {
  const response = await authenticatedFetch(
    `/api/admin/federation-applications/${encodeURIComponent(appId)}/private-link${method === "POST" ? "/check" : ""}`,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    },
  );
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw responseError(
      response,
      result,
      "Application connection",
      "The private link could not be updated.",
    );
  return result as FederationApplication;
}
export const setFederationPrivateLink = (appId: string, target: string) =>
  privateLinkRequest(appId, "PUT", { target });
export const resetFederationPrivateLink = (appId: string) => privateLinkRequest(appId, "DELETE");
export const checkFederationPrivateLink = (appId: string) => privateLinkRequest(appId, "POST");
