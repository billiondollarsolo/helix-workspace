import type postgres from "postgres";
import {
  SYSTEM_TENANT_CONFIG,
  type TenantConfig,
  type TenantFeatureFlags,
  type TenantQuotas,
} from "@helix/sdk-types";
import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type { OrgRecord } from "./orgs.js";

export interface PlanRecord {
  readonly id: string;
  readonly displayName: string;
  readonly featureFlagsDefault: JsonObject;
  readonly quotasDefault: JsonObject;
}

export interface PlanStore {
  findById(id: string): Promise<PlanRecord | null>;
}

interface PlanRow {
  readonly id: string;
  readonly display_name: string;
  readonly feature_flags_default: JsonObject;
  readonly quotas_default: JsonObject;
}

export class PostgresPlanStore implements PlanStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findById(id: string): Promise<PlanRecord | null> {
    const rows = (await this.sql`
      select id, display_name, feature_flags_default, quotas_default
      from plans
      where id = ${id}
      limit 1
    `) as unknown as readonly PlanRow[];
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          displayName: row.display_name,
          featureFlagsDefault: row.feature_flags_default,
          quotasDefault: row.quotas_default,
        };
  }
}

export interface BuildEffectiveTenantConfigInput {
  readonly org: Pick<OrgRecord, "byoConfig" | "featureFlags" | "quotas" | "branding">;
  readonly plan?: Pick<PlanRecord, "featureFlagsDefault" | "quotasDefault"> | null;
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
      input.plan?.featureFlagsDefault,
      input.org.featureFlags,
      input.override?.features,
    ) as TenantFeatureFlags,
    quotas: mergeJsonObjects(
      SYSTEM_TENANT_CONFIG.quotas,
      input.plan?.quotasDefault,
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
