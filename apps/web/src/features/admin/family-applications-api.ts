import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";

export interface FamilyApplication {
  readonly id: string;
  readonly origin: string;
  readonly status: string;
  readonly installationId: string;
  readonly tenantId: string;
  readonly lastSyncedAt: string | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly rotationPending: boolean;
}
export type FamilyRole = "viewer" | "member" | "admin";
export interface FamilyAssignment {
  readonly actorId: string;
  readonly role: FamilyRole;
}
export function familyApplicationsQueryOptions() {
  return queryOptions({
    queryKey: ["admin", "family-applications"],
    retry: false,
    refetchInterval: 15_000,
    queryFn: async () => {
      const response = await authenticatedFetch("/api/admin/family-applications");
      if (response.status === 404)
        return { enabled: false, applications: [] as FamilyApplication[] };
      if (!response.ok)
        throw responseError(
          response,
          await response.json().catch(() => null),
          "Application connection",
          "Application connections could not be loaded.",
        );
      const result = (await response.json()) as { applications: FamilyApplication[] };
      return { ...result, enabled: true };
    },
  });
}
export async function registerFamilyApplication(input: {
  id: string;
  origin: string;
  connectionId: string;
  proof: string;
}) {
  const response = await authenticatedFetch("/api/admin/family-applications", {
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
  return response.json() as Promise<FamilyApplication & { pairingCode: string; expiresAt: string }>;
}
export function familyAssignmentsQueryOptions(appId: string, enabled: boolean) {
  return queryOptions({
    queryKey: ["admin", "family-applications", appId, "assignments"],
    enabled,
    retry: false,
    queryFn: async () => {
      const response = await authenticatedFetch(
        `/api/admin/family-applications/${encodeURIComponent(appId)}/assignments`,
      );
      if (!response.ok)
        throw responseError(
          response,
          await response.json().catch(() => null),
          "Application connection",
          "Application assignments could not be loaded.",
        );
      return response.json() as Promise<{ assignments: FamilyAssignment[] }>;
    },
  });
}
export async function setFamilyAssignments(appId: string, assignments: FamilyAssignment[]) {
  const response = await authenticatedFetch(
    `/api/admin/family-applications/${encodeURIComponent(appId)}/assignments`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignments }),
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
export async function revokeFamilyApplication(appId: string) {
  const response = await authenticatedFetch(
    `/api/admin/family-applications/${encodeURIComponent(appId)}`,
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

export async function rotateFamilyCredential(
  appId: string,
  input: { id: string; kind: "oidc" | "scim" | "enrollment" },
) {
  const response = await authenticatedFetch(
    `/api/admin/family-applications/${encodeURIComponent(appId)}/rotate`,
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
