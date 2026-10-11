import {
  SYSTEM_TENANT_CONFIG,
  type TenantConfig,
  type TenantFeatureFlags,
  type TenantQuotas,
} from "@helix/sdk-types";
import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type { OrgRecord } from "./orgs.js";

/**
 * Effective tenant config = system defaults, then the org's own overrides,
 * then any per-request override. Helix has no plans: the system defaults turn
 * every feature on and leave every quota unlimited (`null`).
 */
export interface BuildEffectiveTenantConfigInput {
  readonly org: Pick<OrgRecord, "byoConfig" | "featureFlags" | "quotas" | "branding">;
  readonly override?: {
    readonly byo?: JsonObject;
    readonly features?: JsonObject;
    readonly quotas?: JsonObject;
    readonly branding?: JsonObject;
  };
}

export function buildEffectiveTenantConfig(input: BuildEffectiveTenantConfigInput): TenantConfig {
  return {
    byo: mergeJsonObjects(SYSTEM_TENANT_CONFIG.byo, input.org.byoConfig, input.override?.byo),
    features: mergeJsonObjects(
      SYSTEM_TENANT_CONFIG.features,
      input.org.featureFlags,
      input.override?.features,
    ) as TenantFeatureFlags,
    quotas: mergeJsonObjects(
      SYSTEM_TENANT_CONFIG.quotas,
      input.org.quotas,
      input.override?.quotas,
    ) as TenantQuotas,
    branding: mergeJsonObjects(
      SYSTEM_TENANT_CONFIG.branding,
      input.org.branding,
      input.override?.branding,
    ),
  };
}

function mergeJsonObjects(...objects: readonly (JsonObject | undefined)[]): JsonObject {
  const merged: Record<string, JsonValue> = {};
  for (const object of objects) {
    if (object === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(object)) {
      merged[key] = value;
    }
  }
  return merged;
}
