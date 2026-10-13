import type postgres from "postgres";
import {
  PostgresPersonLimitStore,
  type PersonLimitValues,
} from "../platform/limits/person-limits.js";
import { loadEffectiveTenantConfig } from "../platform/tenancy/index.js";

type OrgStore = Parameters<typeof loadEffectiveTenantConfig>[0]["orgs"];

const limitOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** The organization's defaults for each person, from its effective settings. */
export function personLimitDefaults(orgs: OrgStore) {
  return async (orgId: string): Promise<PersonLimitValues> => {
    const quotas = (await loadEffectiveTenantConfig({ orgs }, orgId))?.quotas;
    return {
      storageBytes: limitOrNull(quotas?.storage_bytes_per_person_limit),
      mailSendPerHour: limitOrNull(quotas?.mail_send_per_hour_limit),
      mailSendPerDay: limitOrNull(quotas?.mail_send_per_day_limit),
    };
  };
}

export function createPersonLimitStore(sql: postgres.Sql, orgs: OrgStore) {
  return new PostgresPersonLimitStore(sql, personLimitDefaults(orgs));
}
