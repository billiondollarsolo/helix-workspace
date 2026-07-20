import { z } from "zod";

/** JSON object / value primitives used by tenant BYO config. */
const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonPrimitive = z.infer<typeof jsonPrimitiveSchema>;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonObject = { readonly [key: string]: JsonValue };
type JsonArray = readonly JsonValue[];

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(jsonValueSchema);

export const commercialPlanIdSchema = z.enum([
  "personal",
  "pro",
  "business",
  "enterprise",
  "sovereign",
]);
export type CommercialPlanId = z.infer<typeof commercialPlanIdSchema>;

export const dlpEnforcementModeSchema = z.enum(["off", "warn", "block"]);
export type DlpEnforcementMode = z.infer<typeof dlpEnforcementModeSchema>;

export const watermarkModeSchema = z.enum(["off", "visible", "invisible", "both"]);
export type WatermarkMode = z.infer<typeof watermarkModeSchema>;

export const supportTierSchema = z.enum([
  "community",
  "email-48h",
  "priority-24h",
  "premium-4h",
  "premium-1h-named",
]);
export type SupportTier = z.infer<typeof supportTierSchema>;

export const tenantByoConfigSchema = jsonObjectSchema;
export type TenantByoConfig = z.infer<typeof tenantByoConfigSchema>;

export const tenantFeatureFlagsSchema = z
  .object({
    editors_native_document: z.boolean(),
    editors_native_spreadsheet: z.boolean(),
    editors_native_presentation: z.boolean(),
    editors_native_pdf: z.boolean(),
    editors_ai_rag: z.boolean(),
    ai_smart_compose: z.boolean(),
    dlp_enforcement: dlpEnforcementModeSchema,
    watermark: watermarkModeSchema,
    b2b_sharing: z.boolean(),
    mail_outbound: z.boolean(),
    sso_saml: z.boolean(),
    scim_provisioning: z.boolean(),
    custom_domain: z.boolean(),
    byo_storage: z.boolean(),
    byo_database: z.boolean(),
    byo_kms: z.boolean(),
    byo_ai_provider: z.boolean(),
    white_label: z.boolean(),
    multi_region_dr: z.boolean(),
    dedicated_csm: z.boolean(),
    marketplace_install_paid: z.boolean(),
    support_tier: supportTierSchema,
  })
  .passthrough();
export type TenantFeatureFlags = z.infer<typeof tenantFeatureFlagsSchema>;

export const tenantQuotasSchema = z
  .object({
    storage_bytes_limit: z.number().nullable(),
    ai_tokens_monthly_limit: z.number().nullable(),
    ai_image_gen_monthly_limit: z.number().nullable(),
    actors_limit: z.number().nullable(),
    outbound_webhooks_limit: z.number().nullable(),
    api_rps_limit: z.number().nullable(),
    collab_concurrent_editors_per_doc: z.number().nullable(),
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

export const SYSTEM_TENANT_FEATURE_FLAGS = {
  editors_native_document: true,
  editors_native_spreadsheet: true,
  editors_native_presentation: true,
  editors_native_pdf: true,
  editors_ai_rag: false,
  ai_smart_compose: false,
  dlp_enforcement: "off",
  watermark: "off",
  b2b_sharing: false,
  mail_outbound: true,
  sso_saml: false,
  scim_provisioning: false,
  custom_domain: false,
  byo_storage: false,
  byo_database: false,
  byo_kms: false,
  byo_ai_provider: false,
  white_label: false,
  multi_region_dr: false,
  dedicated_csm: false,
  marketplace_install_paid: false,
  support_tier: "community",
} as const satisfies TenantFeatureFlags;

export const SYSTEM_TENANT_QUOTAS = {
  storage_bytes_limit: 5_000_000_000,
  ai_tokens_monthly_limit: 100_000,
  ai_image_gen_monthly_limit: 10,
  actors_limit: 1,
  outbound_webhooks_limit: 5,
  api_rps_limit: 5,
  collab_concurrent_editors_per_doc: 5,
  export_jobs_per_hour: 10,
} as const satisfies TenantQuotas;

export const SYSTEM_TENANT_BRANDING = {} as const satisfies TenantBranding;

export const SYSTEM_TENANT_CONFIG = {
  byo: {},
  features: SYSTEM_TENANT_FEATURE_FLAGS,
  quotas: SYSTEM_TENANT_QUOTAS,
  branding: SYSTEM_TENANT_BRANDING,
} as const satisfies TenantConfig;
