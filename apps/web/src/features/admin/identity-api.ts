import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

const jsonHeaders = { "content-type": "application/json" } as const;
const jsonObjectSchema = z.record(z.string(), z.unknown());

const tenantIdpConfigSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  protocol: z.enum(["saml", "oidc"]),
  isPrimary: z.boolean(),
  displayName: z.string(),
  config: jsonObjectSchema,
  signingCertVaultPath: z.string().nullable(),
  attrMapping: jsonObjectSchema,
  jitProvisioning: z.boolean(),
  enabled: z.boolean(),
  samlSpMetadataUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const localLoginRecoverySchema = z.object({
  enabled: z.literal(true),
  scope: z.literal("owner_admin_recovery"),
});

const identityResponseSchema = z.object({
  idpConfigs: z.array(tenantIdpConfigSchema),
  localLoginRecovery: localLoginRecoverySchema,
});

const idpConfigResponseSchema = z.object({
  idpConfig: tenantIdpConfigSchema,
  localLoginRecovery: localLoginRecoverySchema,
});
const idpTestLoginResponseSchema = z.object({
  testLogin: z.object({
    status: z.enum(["configuration_required", "runtime_pending"]),
    message: z.string(),
  }),
  localLoginRecovery: localLoginRecoverySchema,
});

export type TenantIdpConfig = z.infer<typeof tenantIdpConfigSchema>;
export type AdminIdentityView = z.infer<typeof identityResponseSchema>;
export type AdminIdentityTestLogin = z.infer<typeof idpTestLoginResponseSchema>["testLogin"];
export type TenantIdpProtocol = TenantIdpConfig["protocol"];

export interface CreateTenantIdpConfigInput {
  readonly protocol: TenantIdpProtocol;
  readonly displayName: string;
  readonly config?: Record<string, unknown>;
  readonly signingCertVaultPath?: string | null;
  readonly attrMapping?: Record<string, unknown>;
  readonly isPrimary?: boolean;
  readonly jitProvisioning?: boolean;
  readonly enabled?: boolean;
}

export interface UpdateTenantIdpConfigInput {
  readonly protocol?: TenantIdpProtocol;
  readonly displayName?: string;
  readonly config?: Record<string, unknown>;
  readonly signingCertVaultPath?: string | null;
  readonly attrMapping?: Record<string, unknown>;
  readonly isPrimary?: boolean;
  readonly jitProvisioning?: boolean;
  readonly enabled?: boolean;
}

export const adminIdentityQueryKeys = {
  detail: () => ["admin", "identity", "idp-configs"] as const,
};

export function adminIdentityQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: adminIdentityQueryKeys.detail(),
    queryFn: () => fetchAdminIdentity(fetchImpl),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

export async function fetchAdminIdentity(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AdminIdentityView> {
  const response = await fetchImpl("/api/admin/identity/idp-configs", { method: "GET" });
  return parseResponse(response, "load identity settings", identityResponseSchema);
}

export async function createTenantIdpConfig(
  input: CreateTenantIdpConfigInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantIdpConfig> {
  const response = await fetchImpl("/api/admin/identity/idp-configs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "create IdP config", idpConfigResponseSchema)).idpConfig;
}

export async function promoteTenantIdpConfig(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantIdpConfig> {
  const response = await fetchImpl(
    `/api/admin/identity/idp-configs/${encodeURIComponent(id)}/primary`,
    { method: "POST" },
  );
  return (await parseResponse(response, "promote IdP config", idpConfigResponseSchema)).idpConfig;
}

export async function updateTenantIdpConfig(
  id: string,
  input: UpdateTenantIdpConfigInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantIdpConfig> {
  const response = await fetchImpl(`/api/admin/identity/idp-configs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "update IdP config", idpConfigResponseSchema)).idpConfig;
}

export async function deleteTenantIdpConfig(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantIdpConfig> {
  const response = await fetchImpl(`/api/admin/identity/idp-configs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return (await parseResponse(response, "delete IdP config", idpConfigResponseSchema)).idpConfig;
}

export async function testTenantIdpConfigLogin(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AdminIdentityTestLogin> {
  const response = await fetchImpl(
    `/api/admin/identity/idp-configs/${encodeURIComponent(id)}/test-login`,
    { method: "POST" },
  );
  return (await parseResponse(response, "test IdP login", idpTestLoginResponseSchema)).testLogin;
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
