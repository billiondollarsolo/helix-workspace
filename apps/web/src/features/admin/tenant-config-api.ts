import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

const jsonHeaders = { "content-type": "application/json" } as const;

const jsonObjectSchema = z.record(z.unknown());

const tenantConfigSchema = z.object({
  orgId: z.string(),
  byo: jsonObjectSchema,
  features: jsonObjectSchema,
  quotas: jsonObjectSchema,
  branding: jsonObjectSchema,
  plan: z
    .object({
      id: z.string(),
      displayName: z.string(),
      featureFlagsDefault: jsonObjectSchema,
      quotasDefault: jsonObjectSchema,
    })
    .nullable(),
  effective: z.object({
    byo: jsonObjectSchema,
    features: jsonObjectSchema,
    quotas: jsonObjectSchema,
    branding: jsonObjectSchema,
  }),
});

const tenantConfigResponseSchema = z.object({ tenantConfig: tenantConfigSchema });
const storageHealthSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  checked_at: z.string(),
  message: z.string(),
  managedBy: z.enum(["helix-default", "byo"]).optional(),
  prefix: z.string().optional(),
});
const storageHealthResponseSchema = z.object({ health: storageHealthSchema });

export type TenantConfigAdminView = z.infer<typeof tenantConfigSchema>;
export type TenantStorageHealthResult = z.infer<typeof storageHealthSchema>;

export interface UpdateTenantConfigInput {
  readonly byo?: Record<string, unknown>;
  readonly features?: Record<string, unknown>;
  readonly quotas?: Record<string, unknown>;
  readonly branding?: Record<string, unknown>;
  readonly reason?: string;
}

export const tenantConfigQueryKeys = {
  detail: () => ["admin", "tenant-config"] as const,
};

export function tenantConfigQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: tenantConfigQueryKeys.detail(),
    queryFn: () => fetchTenantConfig(fetchImpl),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

export async function fetchTenantConfig(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantConfigAdminView> {
  const response = await fetchImpl("/api/admin/tenant-config", { method: "GET" });
  return (await parseResponse(response, "load tenant config", tenantConfigResponseSchema))
    .tenantConfig;
}

export async function updateTenantConfig(
  input: UpdateTenantConfigInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantConfigAdminView> {
  const response = await fetchImpl("/api/admin/tenant-config", {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "update tenant config", tenantConfigResponseSchema))
    .tenantConfig;
}

export async function testByoStorage(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantStorageHealthResult> {
  const response = await fetchImpl("/api/admin/tenant-config/byo-storage/test", {
    method: "POST",
  });
  return (await parseResponse(response, "test BYO storage", storageHealthResponseSchema)).health;
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
