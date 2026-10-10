import type { TenantConfigAdminStore } from "../platform/admin/tenant-config.js";
import type { OrgRecord, UpdateTenantConfigInput } from "../platform/tenancy/orgs.js";
import {
  applyTenantConfigPatch,
  FEATURE_FLAGS_PATCH,
  QUOTAS_PATCH,
} from "../platform/tenancy/tenant-config-patch.js";

/** Tenant config store double with the same write semantics as PostgresOrgStore. */
export class InMemoryTenantConfigAdminStore implements TenantConfigAdminStore {
  readonly updates: UpdateTenantConfigInput[] = [];
  #org: OrgRecord | null;

  constructor(orgId: string, overrides: Partial<OrgRecord> = {}) {
    this.#org = {
      id: orgId,
      slug: "acme",
      displayName: "Acme",
      status: "active",
      tier: "business",
      planId: "business",
      region: "us-east-1",
      byoConfig: {},
      featureFlags: { ai_smart_compose: false },
      quotas: { api_rps_limit: 5 },
      branding: {},
      suspendedAt: null,
      softDeletedAt: null,
      hardDeletedAt: null,
      ...overrides,
    };
  }

  async findById(id: string): Promise<OrgRecord | null> {
    return id === this.#org?.id ? this.#org : null;
  }

  async updateTenantConfig(input: UpdateTenantConfigInput): Promise<OrgRecord | null> {
    this.updates.push(input);
    const org = this.#org;
    if (org === null || input.orgId !== org.id) {
      return null;
    }
    this.#org = {
      ...org,
      ...(input.byoConfig === undefined ? {} : { byoConfig: input.byoConfig }),
      featureFlags: applyTenantConfigPatch(
        org.featureFlags,
        input.featureFlags ?? {},
        FEATURE_FLAGS_PATCH,
      ),
      quotas: applyTenantConfigPatch(org.quotas, input.quotas ?? {}, QUOTAS_PATCH),
      ...(input.branding === undefined ? {} : { branding: input.branding }),
    };
    return this.#org;
  }
}
