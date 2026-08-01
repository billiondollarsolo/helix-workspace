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

// Migration 0031 seeds (DEFAULT_ORG_ID, 'default'), and .env.example used to ship a
// different HELIX_DEFAULT_ORG_ID against that same slug.
const MISCONFIGURED_ORG_ID = "00000000-0000-4000-8000-000000000100";

describe("PostgresOrgStore", () => {
  it("provisions a tenant Postgres role for the resolved default org", async () => {
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

  it("inserts the default org on an empty database without targeting a single unique index", async () => {
    const provisionedOrgIds: string[] = [];
    const recording = createRecordingSql([[], [], [orgRow()]]);
    const store = new PostgresOrgStore(recording.sql, {
      tenantRoleProvisioner: {
        async ensureRoleForOrg(orgId) {
          provisionedOrgIds.push(orgId);
        },
      },
    });

    await expect(store.getOrCreateDefaultOrg()).resolves.toMatchObject({
      id: DEFAULT_ORG_ID,
      slug: DEFAULT_ORG_SLUG,
    });

    expect(recording.calls[0]?.text).toContain("where id = ?");
    expect(recording.calls[1]?.text).toContain("where slug = ?");
    expect(recording.calls[2]?.text).toContain("insert into orgs");
    // `on conflict (id)` let a collision on orgs_slug_idx escape as a PostgresError.
    expect(recording.calls[2]?.text).toContain("on conflict do nothing");
    expect(recording.calls[2]?.text).not.toContain("on conflict (id)");
    expect(provisionedOrgIds).toEqual([DEFAULT_ORG_ID]);
  });

  it("returns the stored default org without re-inserting once it exists", async () => {
    const recording = createRecordingSql([[orgRow()]]);
    const store = new PostgresOrgStore(recording.sql);

    await expect(store.getOrCreateDefaultOrg()).resolves.toMatchObject({ id: DEFAULT_ORG_ID });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls.map((call) => call.text).join("\n")).not.toContain("insert into orgs");
  });

  it("refuses to boot when the configured default org id disagrees with the stored slug owner", async () => {
    const provisionedOrgIds: string[] = [];
    const recording = createRecordingSql([[], [orgRow({ id: DEFAULT_ORG_ID })]]);
    const store = new PostgresOrgStore(recording.sql, {
      tenantRoleProvisioner: {
        async ensureRoleForOrg(orgId) {
          provisionedOrgIds.push(orgId);
        },
      },
    });

    await expect(store.getOrCreateDefaultOrg({ id: MISCONFIGURED_ORG_ID })).rejects.toThrow(
      /default org id mismatch/,
    );

    // Both ids belong in the message: the operator has to know which one to change.
    await expect(
      new PostgresOrgStore(
        createRecordingSql([[], [orgRow({ id: DEFAULT_ORG_ID })]]).sql,
      ).getOrCreateDefaultOrg({ id: MISCONFIGURED_ORG_ID }),
    ).rejects.toThrow(new RegExp(`${DEFAULT_ORG_ID}[\\s\\S]*${MISCONFIGURED_ORG_ID}`));

    // The insert never runs, so the unique violation cannot resurface.
    expect(recording.calls.map((call) => call.text).join("\n")).not.toContain("insert into orgs");
    expect(provisionedOrgIds).toEqual([]);
  });

  it("adopts the stored default org when only its slug drifted from the configured one", async () => {
    const recording = createRecordingSql([[orgRow({ slug: "local-demo" })]]);
    const store = new PostgresOrgStore(recording.sql);

    await expect(store.getOrCreateDefaultOrg()).resolves.toMatchObject({
      id: DEFAULT_ORG_ID,
      slug: "local-demo",
    });

    expect(recording.calls.map((call) => call.text).join("\n")).not.toContain("insert into orgs");
  });

  it("re-reads the default org when a concurrently booting replica won the insert", async () => {
    const recording = createRecordingSql([[], [], [], [orgRow()]]);
    const store = new PostgresOrgStore(recording.sql);

    await expect(store.getOrCreateDefaultOrg()).resolves.toMatchObject({ id: DEFAULT_ORG_ID });

    expect(recording.calls[2]?.text).toContain("insert into orgs");
    expect(recording.calls[3]?.text).toContain("where id = ?");
  });

  it("fails loudly when the default org insert conflicts but no row can be found", async () => {
    const store = new PostgresOrgStore(createRecordingSql([[], [], [], [], []]).sql);

    await expect(store.getOrCreateDefaultOrg()).rejects.toThrow(/could not be created or found/);
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

  it("applies tenant lifecycle actions with bounded status transitions", async () => {
    const suspendedAt = new Date("2026-05-24T00:00:00.000Z");
    const softDeletedAt = new Date("2026-05-25T00:00:00.000Z");
    const recording = createRecordingSql([
      [orgRow({ slug: "acme", status: "suspended", suspendedAt })],
      [orgRow({ slug: "acme", status: "active" })],
      [orgRow({ slug: "acme", status: "soft_deleted", softDeletedAt })],
      [orgRow({ slug: "acme", status: "active" })],
      [],
    ]);
    const store = new PostgresOrgStore(recording.sql);

    await expect(
      store.applyTenantLifecycleAction({ slug: "acme", action: "suspend" }),
    ).resolves.toMatchObject({ slug: "acme", status: "suspended", suspendedAt });
    await expect(
      store.applyTenantLifecycleAction({ slug: "acme", action: "unsuspend" }),
    ).resolves.toMatchObject({ slug: "acme", status: "active", suspendedAt: null });
    await expect(
      store.applyTenantLifecycleAction({ slug: "acme", action: "soft-delete" }),
    ).resolves.toMatchObject({ slug: "acme", status: "soft_deleted", softDeletedAt });
    await expect(
      store.applyTenantLifecycleAction({ slug: "acme", action: "restore" }),
    ).resolves.toMatchObject({ slug: "acme", status: "active", softDeletedAt: null });
    await expect(
      store.applyTenantLifecycleAction({ slug: "acme", action: "suspend" }),
    ).resolves.toBeNull();

    expect(recording.calls[0]?.text).toContain("and status = 'active'");
    expect(recording.calls[1]?.text).toContain("and status = 'suspended'");
    expect(recording.calls[2]?.text).toContain("and status in ('active', 'suspended')");
    expect(recording.calls[3]?.text).toContain("and status = 'soft_deleted'");
    expect(recording.calls[3]?.text).toContain("hard_deleted_at is null");
    expect(recording.calls.map((call) => call.values)).toEqual([
      ["acme"],
      ["acme"],
      ["acme"],
      ["acme"],
      ["acme"],
    ]);
  });

  it("lists due soft-deleted tenants and marks hard-delete tombstones", async () => {
    const softDeletedAt = new Date("2026-04-01T00:00:00.000Z");
    const hardDeletedAt = new Date("2026-05-24T00:00:00.000Z");
    const recording = createRecordingSql([
      [
        orgRow({ id: "org-a", slug: "acme", status: "soft_deleted", softDeletedAt }),
        orgRow({ id: "org-b", slug: "beta", status: "soft_deleted", softDeletedAt }),
      ],
      [orgRow({ id: "org-a", slug: "acme", status: "hard_deleted", hardDeletedAt })],
      [],
    ]);
    const store = new PostgresOrgStore(recording.sql);

    await expect(
      store.listSoftDeletedTenantsDueForHardDelete({
        before: new Date("2026-04-24T00:00:00.000Z"),
        limit: 2,
      }),
    ).resolves.toEqual([
      orgRecord({ id: "org-a", slug: "acme", status: "soft_deleted", softDeletedAt }),
      orgRecord({ id: "org-b", slug: "beta", status: "soft_deleted", softDeletedAt }),
    ]);
    await expect(store.markTenantHardDeleted({ orgId: "org-a" })).resolves.toMatchObject({
      id: "org-a",
      status: "hard_deleted",
      hardDeletedAt,
    });
    await expect(store.markTenantHardDeleted({ orgId: "org-missing" })).resolves.toBeNull();

    expect(recording.calls[0]?.text).toContain("soft_deleted_at <= ?");
    expect(recording.calls[0]?.text).toContain("hard_deleted_at is null");
    expect(recording.calls[0]?.text).toContain("limit ?");
    expect(recording.calls[0]?.values).toEqual([new Date("2026-04-24T00:00:00.000Z"), 2]);
    expect(recording.calls[1]?.text).toContain("status = 'hard_deleted'");
    expect(recording.calls[1]?.text).toContain("and status = 'soft_deleted'");
    expect(recording.calls[1]?.text).toContain("hard_deleted_at is null");
  });

  it("updates tenant config sections with audit trigger context", async () => {
    const recording = createRecordingSql([
      [],
      [
        orgRow({
          featureFlags: { ai_smart_compose: true },
          quotas: { api_rps_limit: 10 },
        }),
      ],
    ]);
    const store = new PostgresOrgStore(recording.sql);

    const org = await store.updateTenantConfig({
      orgId: "11111111-1111-4111-8111-111111111111",
      featureFlags: { ai_smart_compose: true },
      quotas: { api_rps_limit: 10 },
      changedByActorId: "22222222-2222-4222-8222-222222222222",
      reason: "admin settings update",
    });

    expect(org).toMatchObject({
      featureFlags: { ai_smart_compose: true },
      quotas: { api_rps_limit: 10 },
    });
    expect(recording.calls[0]?.text).toContain("helix.tenant_config_changed_by");
    expect(recording.calls[0]?.text).toContain("helix.tenant_config_reason");
    expect(recording.calls[0]?.values).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "admin settings update",
    ]);
    expect(recording.calls[1]?.text).toContain("update orgs");
    expect(recording.calls[1]?.text).toContain("feature_flags = case");
    expect(recording.calls[1]?.text).toContain("quotas = case");
    expect(recording.calls[1]?.values).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("lists BYO storage orgs and persists bounded health", async () => {
    const recording = createRecordingSql([
      [{ id: "org-a" }, { id: "org-b" }],
      [],
      [
        orgRow({
          id: "org-a",
          byoConfig: {
            storage: {
              kind: "byo",
              health: {
                status: "healthy",
                checked_at: "2026-05-24T00:00:00.000Z",
                message: "ok",
              },
            },
          },
        }),
      ],
    ]);
    const store = new PostgresOrgStore(recording.sql);

    await expect(store.listByoStorageOrgIds({ limit: 2 })).resolves.toEqual(["org-a", "org-b"]);
    await expect(
      store.updateByoStorageHealth({
        orgId: "org-a",
        health: {
          status: "healthy",
          checked_at: "2026-05-24T00:00:00.000Z",
          message: "ok",
        },
        reason: "byo-storage-health-worker",
      }),
    ).resolves.toMatchObject({
      id: "org-a",
      byoConfig: {
        storage: {
          kind: "byo",
          health: {
            status: "healthy",
            checked_at: "2026-05-24T00:00:00.000Z",
            message: "ok",
          },
        },
      },
    });

    expect(recording.calls[0]?.text).toContain("feature_flags->>'byo_storage' = 'true'");
    expect(recording.calls[0]?.text).toContain("byo_config->'storage'->>'kind' = 'byo'");
    expect(recording.calls[0]?.values).toEqual([2]);
    expect(recording.calls[1]?.text).toContain("helix.tenant_config_reason");
    expect(recording.calls[2]?.text).toContain("jsonb_set");
    expect(recording.calls[2]?.text).toContain("'{storage,health}'");
    expect(recording.calls[2]?.text).toContain("byo_config->'storage'->>'kind' = 'byo'");
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
  const tag = () => Promise.resolve([orgRow(overrides)]);
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return sql;
}

function orgRow(overrides: Partial<OrgRecord> = {}) {
  return {
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
  };
}

function createRecordingSql(resultSets: unknown[][]): {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[];
  readonly sql: postgres.Sql;
} {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const queue = [...resultSets];
  const tag = (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { calls, sql };
}
