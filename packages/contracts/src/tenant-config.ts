import { z } from "zod";

/** JSON object / value primitives used by tenant BYO config. */
const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonPrimitive = z.infer<typeof jsonPrimitiveSchema>;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonObject = { readonly [key: string]: JsonValue };
type JsonArray = readonly JsonValue[];

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const tenantByoConfigSchema = jsonObjectSchema;
export type TenantByoConfig = z.infer<typeof tenantByoConfigSchema>;

/**
 * Tenant feature flags: org-admin policy switches. `assistant_retrieval` and
 * `mail_outbound` default to on; `calendar_import_invitations` and
 * `chat_admin_private_rooms` are opt-ins.
 * The stored object also carries structured policies such as
 * `mail_inbound_policy`, which the app validates where it reads them.
 */
export const tenantFeatureFlagsSchema = z
  .object({
    assistant_retrieval: z.boolean(),
    mail_outbound: z.boolean(),
    calendar_import_invitations: z.boolean(),
    drive_s3_api: z.boolean(),
    chat_admin_private_rooms: z.boolean(),
  })
  .passthrough();
export type TenantFeatureFlags = z.infer<typeof tenantFeatureFlagsSchema>;

/**
 * Tenant quotas. `null` means unlimited, which is the system default. An org
 * admin may set an explicit cap for its own tenant.
 */
export const tenantQuotasSchema = z
  .object({
    storage_bytes_limit: z.number().nullable(),
    ai_tokens_monthly_limit: z.number().nullable(),
    ai_image_gen_monthly_limit: z.number().nullable(),
    actors_limit: z.number().nullable(),
    outbound_webhooks_limit: z.number().nullable(),
    api_rps_limit: z.number().nullable(),
    export_jobs_per_hour: z.number().nullable(),
  })
  .passthrough();
export type TenantQuotas = z.infer<typeof tenantQuotasSchema>;

export const tenantBrandingSchema = z
  .object({
    logo_url: z.string().optional(),
    accent_color_hex: z.string().optional(),
    display_name_override: z.string().optional(),
    email_from_name: z.string().optional(),
    email_from_domain: z.string().optional(),
    custom_domain: z.string().optional(),
  })
  .passthrough();
export type TenantBranding = z.infer<typeof tenantBrandingSchema>;

export const tenantConfigSchema = z.object({
  byo: tenantByoConfigSchema,
  features: tenantFeatureFlagsSchema,
  quotas: tenantQuotasSchema,
  branding: tenantBrandingSchema,
});
export type TenantConfig = z.infer<typeof tenantConfigSchema>;

/** Flags an admin has to turn on; every other flag defaults to on. */
export const OPT_IN_TENANT_FEATURE_FLAGS: readonly string[] = [
  "calendar_import_invitations",
  "chat_admin_private_rooms",
];

export const SYSTEM_TENANT_FEATURE_FLAGS = {
  assistant_retrieval: true,
  mail_outbound: true,
  calendar_import_invitations: false,
  drive_s3_api: true,
  chat_admin_private_rooms: false,
} as const satisfies TenantFeatureFlags;

export const SYSTEM_TENANT_QUOTAS = {
  storage_bytes_limit: null,
  ai_tokens_monthly_limit: null,
  ai_image_gen_monthly_limit: null,
  actors_limit: null,
  outbound_webhooks_limit: null,
  api_rps_limit: null,
  export_jobs_per_hour: null,
} as const satisfies TenantQuotas;

export const SYSTEM_TENANT_BRANDING = {} as const satisfies TenantBranding;

export const SYSTEM_TENANT_CONFIG = {
  byo: {},
  features: SYSTEM_TENANT_FEATURE_FLAGS,
  quotas: SYSTEM_TENANT_QUOTAS,
  branding: SYSTEM_TENANT_BRANDING,
} as const satisfies TenantConfig;
