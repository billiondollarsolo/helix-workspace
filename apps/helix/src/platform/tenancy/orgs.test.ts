import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  DEFAULT_ORG_DISPLAY_NAME,
  DEFAULT_ORG_ID,
  DEFAULT_ORG_REGION,
  DEFAULT_ORG_SLUG,
  ensureDefaultOrgForMode,
  PostgresOrgStore,
  type DefaultOrgInput,
  type OrgRecord,
  resolveDefaultOrgInput,
} from "./orgs.js";

describe("resolveDefaultOrgInput", () => {
  it("uses stable single-tenant defaults", () => {
    expect(resolveDefaultOrgInput({})).toEqual({
      id: DEFAULT_ORG_ID,
      slug: DEFAULT_ORG_SLUG,
      displayName: DEFAULT_ORG_DISPLAY_NAME,
      region: DEFAULT_ORG_REGION,
    });
  });

  it("reads default org overrides from the environment", () => {
    expect(
      resolveDefaultOrgInput({
        HELIX_DEFAULT_ORG_ID: "11111111-1111-4111-8111-111111111111",
        HELIX_DEFAULT_ORG_SLUG: "acme",
        HELIX_DEFAULT_ORG_NAME: "Acme Corp",
        HELIX_DEFAULT_ORG_REGION: "us-east-1",
      }),
    ).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme",
      displayName: "Acme Corp",
      region: "us-east-1",
    });
  });
});

describe("ensureDefaultOrgForMode", () => {
  it("creates or verifies the default org at boot in single-tenant mode", async () => {
    const calls: DefaultOrgInput[] = [];
    const org = await ensureDefaultOrgForMode({
      config: { mode: "single-tenant" },
      defaultOrg: { id: "11111111-1111-4111-8111-111111111111", slug: "acme" },
      orgs: {
        async getOrCreateDefaultOrg(input) {
          calls.push(input ?? {});
          return orgRecord({
            ...(input?.id === undefined ? {} : { id: input.id }),
            ...(input?.slug === undefined ? {} : { slug: input.slug }),
          });
        },
      },
    });

    expect(calls).toEqual([{ id: "11111111-1111-4111-8111-111111111111", slug: "acme" }]);
    expect(org).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme",
    });
  });

  it("does not create a default org during multi-tenant SaaS boot", async () => {
    let calls = 0;
    const org = await ensureDefaultOrgForMode({
      config: { mode: "multi-tenant-saas" },
      orgs: {
        async getOrCreateDefaultOrg() {
          calls += 1;
          return orgRecord({});
        },
      },
    });

    expect(org).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("PostgresOrgStore", () => {
  it("provisions a tenant Postgres role after default org creation", async () => {
    const provisionedOrgIds: string[] = [];
    const store = new PostgresOrgStore(sqlReturningOrg(), {
      tenantRoleProvisioner: {
        async ensureRoleForOrg(orgId) {
          provisionedOrgIds.push(orgId);
        },
      },
    });

    const org = await store.getOrCreateDefaultOrg({ id: DEFAULT_ORG_ID });

    expect(org.id).toBe(DEFAULT_ORG_ID);
    expect(provisionedOrgIds).toEqual([DEFAULT_ORG_ID]);
  });

  it("creates SaaS orgs in provisioning status and provisions their tenant role", async () => {
    const provisionedOrgIds: string[] = [];
    const store = new PostgresOrgStore(sqlReturningOrg({ status: "provisioning", slug: "acme" }), {
      tenantRoleProvisioner: {
        async ensureRoleForOrg(orgId) {
          provisionedOrgIds.push(orgId);
        },
      },
    });

    const org = await store.createOrg({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme",
      displayName: "Acme",
    });

    expect(org).toMatchObject({
      id: DEFAULT_ORG_ID,
      slug: "acme",
      status: "provisioning",
    });
    expect(provisionedOrgIds).toEqual([DEFAULT_ORG_ID]);
  });

  it("activates only provisioning orgs", async () => {
    const recording = sqlReturningOrg({ status: "active", slug: "acme" });
    const store = new PostgresOrgStore(recording);

    const org = await store.activateProvisionedOrg("11111111-1111-4111-8111-111111111111");

    expect(org).toMatchObject({ slug: "acme", status: "active" });
  });
});

function orgRecord(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    id: DEFAULT_ORG_ID,
    slug: DEFAULT_ORG_SLUG,
    displayName: DEFAULT_ORG_DISPLAY_NAME,
    status: "active",
    tier: "personal",
    planId: "personal",
    region: DEFAULT_ORG_REGION,
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}

function sqlReturningOrg(overrides: Partial<OrgRecord> = {}): postgres.Sql {
  const tag = () =>
    Promise.resolve([
      {
        id: overrides.id ?? DEFAULT_ORG_ID,
        slug: overrides.slug ?? DEFAULT_ORG_SLUG,
        display_name: overrides.displayName ?? DEFAULT_ORG_DISPLAY_NAME,
        status: overrides.status ?? "active",
        tier: overrides.tier ?? "personal",
        plan_id: overrides.planId ?? "personal",
        region: overrides.region ?? DEFAULT_ORG_REGION,
        byo_config: overrides.byoConfig ?? {},
        feature_flags: overrides.featureFlags ?? {},
        quotas: overrides.quotas ?? {},
        branding: overrides.branding ?? {},
        suspended_at: overrides.suspendedAt ?? null,
        soft_deleted_at: overrides.softDeletedAt ?? null,
        hard_deleted_at: overrides.hardDeletedAt ?? null,
      },
    ]);
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return sql;
}
