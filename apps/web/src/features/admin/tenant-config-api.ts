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
const storageCredentialsResponseSchema = z.object({
  credentials: z.object({
    credentials_vault_path: z.string(),
    rotated: z.boolean(),
  }),
  health: storageHealthSchema,
});
const storageMigrationTargetSchema = z.enum(["byo", "helix-default"]);
const storageMigrationStorageStateSchema = z.object({
  managedBy: storageMigrationTargetSchema,
  storage: jsonObjectSchema.nullable(),
});
const storageMigrationFailureSchema = z.object({
  storageKey: z.string(),
  reason: z.string(),
});
const storageMigrationJobSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  target: storageMigrationTargetSchema,
  status: z.enum(["queued", "running", "succeeded", "succeeded_with_errors", "failed", "dry_run"]),
  dryRun: z.boolean(),
  sourceStorage: storageMigrationStorageStateSchema.nullable(),
  targetStorage: storageMigrationStorageStateSchema.nullable(),
  plannedCount: z.number(),
  copiedCount: z.number(),
  verifiedCount: z.number(),
  failures: z.array(storageMigrationFailureSchema),
  lastError: z.string().nullable(),
  attemptCount: z.number(),
  requestedByActorId: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const storageMigrationResponseSchema = z.object({ migration: storageMigrationJobSchema });
const storageMigrationListResponseSchema = z.object({
  migrations: z.array(storageMigrationJobSchema),
  nextCursor: z.string().nullable(),
});
const storageMigrationCutoverResponseSchema = z.object({
  migration: storageMigrationJobSchema,
  tenantConfig: tenantConfigSchema,
});

export type TenantConfigAdminView = z.infer<typeof tenantConfigSchema>;
export type TenantStorageHealthResult = z.infer<typeof storageHealthSchema>;
export type TenantStorageMigrationTarget = z.infer<typeof storageMigrationTargetSchema>;
export type TenantStorageMigrationStorageState = z.infer<typeof storageMigrationStorageStateSchema>;
export type TenantStorageMigrationJob = z.infer<typeof storageMigrationJobSchema>;

export interface UpdateTenantConfigInput {
  readonly byo?: Record<string, unknown>;
  readonly features?: Record<string, unknown>;
  readonly quotas?: Record<string, unknown>;
  readonly branding?: Record<string, unknown>;
  readonly reason?: string;
}

export interface RequestTenantStorageMigrationInput {
  readonly target?: TenantStorageMigrationTarget;
  readonly dryRun?: boolean;
  readonly sourceStorage?: Record<string, unknown>;
  readonly targetStorage?: Record<string, unknown>;
}

export interface RotateByoStorageCredentialsInput {
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly reason?: string;
}

export interface FetchTenantStorageMigrationsInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TenantStorageMigrationsPage {
  readonly migrations: readonly TenantStorageMigrationJob[];
  readonly nextCursor: string | null;
}

export interface RotateByoStorageCredentialsResult {
  readonly credentials: {
    readonly credentials_vault_path: string;
    readonly rotated: boolean;
  };
  readonly health: TenantStorageHealthResult;
}

export const tenantConfigQueryKeys = {
  detail: () => ["admin", "tenant-config"] as const,
  storageMigrations: () => ["admin", "tenant-config", "storage-migrations"] as const,
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

export function tenantStorageMigrationsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: tenantConfigQueryKeys.storageMigrations(),
    queryFn: () => fetchTenantStorageMigrations({ limit: 10 }, fetchImpl),
    retry: false,
    staleTime: 15_000,
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

export async function rotateByoStorageCredentials(
  input: RotateByoStorageCredentialsInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<RotateByoStorageCredentialsResult> {
  const response = await fetchImpl("/api/admin/tenant-config/byo-storage/credentials", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(
    response,
    "rotate BYO storage credentials",
    storageCredentialsResponseSchema,
  );
}

export async function requestTenantStorageMigration(
  input: RequestTenantStorageMigrationInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantStorageMigrationJob> {
  const response = await fetchImpl("/api/admin/tenant-config/byo-storage/migrations", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (
    await parseResponse(
      response,
      "request tenant storage migration",
      storageMigrationResponseSchema,
    )
  ).migration;
}

export async function fetchTenantStorageMigrations(
  input: FetchTenantStorageMigrationsInput = {},
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantStorageMigrationsPage> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) {
    params.set("limit", String(input.limit));
  }
  if (input.cursor !== undefined && input.cursor.trim().length > 0) {
    params.set("cursor", input.cursor.trim());
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const response = await fetchImpl(`/api/admin/tenant-config/byo-storage/migrations${query}`, {
    method: "GET",
  });
  return parseResponse(
    response,
    "load tenant storage migrations",
    storageMigrationListResponseSchema,
  );
}

export async function fetchTenantStorageMigration(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<TenantStorageMigrationJob> {
  const response = await fetchImpl(`/api/admin/tenant-config/byo-storage/migrations/${id}`, {
    method: "GET",
  });
  return (
    await parseResponse(response, "load tenant storage migration", storageMigrationResponseSchema)
  ).migration;
}

export async function cutoverTenantStorageMigration(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<{
  readonly migration: TenantStorageMigrationJob;
  readonly tenantConfig: TenantConfigAdminView;
}> {
  const response = await fetchImpl(
    `/api/admin/tenant-config/byo-storage/migrations/${id}/cutover`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ confirm: "CUTOVER" }),
    },
  );
  return parseResponse(
    response,
    "cut over tenant storage migration",
    storageMigrationCutoverResponseSchema,
  );
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
