import type { JsonObject } from "./json.js";

export type CommercialPlanId = "personal" | "pro" | "business" | "enterprise" | "sovereign";
export type DlpEnforcementMode = "off" | "warn" | "block";
export type WatermarkMode = "off" | "visible" | "invisible" | "both";
export type SupportTier =
  | "community"
  | "email-48h"
  | "priority-24h"
  | "premium-4h"
  | "premium-1h-named";

export type TenantByoConfig = JsonObject;

export type TenantFeatureFlags = JsonObject & {
  readonly editors_native_document: boolean;
  readonly editors_native_spreadsheet: boolean;
  readonly editors_native_presentation: boolean;
  readonly editors_native_pdf: boolean;
  readonly editors_ai_rag: boolean;
  readonly ai_smart_compose: boolean;
  readonly dlp_enforcement: DlpEnforcementMode;
  readonly watermark: WatermarkMode;
  readonly b2b_sharing: boolean;
  readonly mail_outbound: boolean;
  readonly sso_saml: boolean;
  readonly scim_provisioning: boolean;
  readonly custom_domain: boolean;
  readonly byo_storage: boolean;
  readonly byo_database: boolean;
  readonly byo_kms: boolean;
  readonly byo_ai_provider: boolean;
  readonly white_label: boolean;
  readonly multi_region_dr: boolean;
  readonly dedicated_csm: boolean;
  readonly marketplace_install_paid: boolean;
  readonly support_tier: SupportTier;
};

export type TenantQuotas = JsonObject & {
  readonly storage_bytes_limit: number | null;
  readonly ai_tokens_monthly_limit: number | null;
  readonly ai_image_gen_monthly_limit: number | null;
  readonly actors_limit: number | null;
  readonly outbound_webhooks_limit: number | null;
  readonly api_rps_limit: number | null;
  readonly collab_concurrent_editors_per_doc: number | null;
  readonly export_jobs_per_hour: number | null;
};

export type TenantBranding = JsonObject & {
  readonly logo_url?: string;
  readonly accent_color_hex?: string;
  readonly display_name_override?: string;
  readonly email_from_name?: string;
  readonly email_from_domain?: string;
  readonly custom_domain?: string;
};

export interface TenantConfig {
  readonly byo: TenantByoConfig;
  readonly features: TenantFeatureFlags;
  readonly quotas: TenantQuotas;
  readonly branding: TenantBranding;
}

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
