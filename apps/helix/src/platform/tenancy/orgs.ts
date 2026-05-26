import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { HelixConfig, JsonObject } from "@helix/sdk-types";
import { isSingleTenant } from "../mode/index.js";
import type { TenantPostgresRoleProvisioner } from "./postgres-roles.js";

export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";
export const DEFAULT_ORG_SLUG = "default";
export const DEFAULT_ORG_DISPLAY_NAME = "Default Organization";
export const DEFAULT_ORG_REGION = "default";

export type OrgStatus = "provisioning" | "active" | "suspended" | "soft_deleted" | "hard_deleted";

export interface OrgRecord {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: OrgStatus;
  readonly tier: string;
  readonly planId: string;
  readonly region: string;
  readonly byoConfig: JsonObject;
  readonly featureFlags: JsonObject;
  readonly quotas: JsonObject;
  readonly branding: JsonObject;
  readonly suspendedAt: Date | null;
  readonly softDeletedAt: Date | null;
  readonly hardDeletedAt: Date | null;
}

export interface DefaultOrgInput {
  readonly id?: string;
  readonly slug?: string;
  readonly displayName?: string;
  readonly region?: string;
}

export interface CreateOrgInput {
  readonly id?: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status?: OrgStatus;
  readonly tier?: string;
  readonly planId?: string;
  readonly region?: string;
  readonly byoConfig?: JsonObject;
  readonly featureFlags?: JsonObject;
  readonly quotas?: JsonObject;
  readonly branding?: JsonObject;
}

export interface UpdateTenantConfigInput {
  readonly orgId: string;
  readonly byoConfig?: JsonObject | undefined;
  readonly featureFlags?: JsonObject | undefined;
  readonly quotas?: JsonObject | undefined;
  readonly branding?: JsonObject | undefined;
  readonly changedByActorId?: string | null | undefined;
  readonly reason?: string | undefined;
}

export interface CutoverTenantStorageConfigInput {
  readonly orgId: string;
  readonly expectedCurrentStorage: JsonObject | null;
  readonly storageConfig: JsonObject;
  readonly enableByoStorage?: boolean | undefined;
  readonly changedByActorId?: string | null | undefined;
  readonly reason?: string | undefined;
}

export interface TenantByoStorageHealth {
  readonly status: "healthy" | "degraded";
  readonly checked_at: string;
  readonly message: string;
}

export interface UpdateByoStorageHealthInput {
  readonly orgId: string;
  readonly health: TenantByoStorageHealth;
  readonly reason?: string | undefined;
}

export type TenantLifecycleAction = "suspend" | "unsuspend" | "soft-delete" | "restore";

export function resolveDefaultOrgInput(env: NodeJS.ProcessEnv): Required<DefaultOrgInput> {
  return {
    id: env.HELIX_DEFAULT_ORG_ID ?? DEFAULT_ORG_ID,
    slug: env.HELIX_DEFAULT_ORG_SLUG ?? DEFAULT_ORG_SLUG,
    displayName: env.HELIX_DEFAULT_ORG_NAME ?? DEFAULT_ORG_DISPLAY_NAME,
    region: env.HELIX_DEFAULT_ORG_REGION ?? DEFAULT_ORG_REGION,
  };
}

export interface OrgStore {
  createOrg(input: CreateOrgInput): Promise<OrgRecord>;
  getOrCreateDefaultOrg(input?: DefaultOrgInput): Promise<OrgRecord>;
  activateProvisionedOrg(id: string): Promise<OrgRecord | null>;
  findById(id: string): Promise<OrgRecord | null>;
  findBySlug(slug: string): Promise<OrgRecord | null>;
}

export interface PostgresOrgStoreOptions {
  readonly tenantRoleProvisioner?: TenantPostgresRoleProvisioner;
}

export async function ensureDefaultOrgForMode(input: {
  readonly config: Pick<HelixConfig, "mode">;
  readonly orgs: Pick<OrgStore, "getOrCreateDefaultOrg">;
  readonly defaultOrg?: DefaultOrgInput;
}): Promise<OrgRecord | null> {
  if (!isSingleTenant(input.config)) {
    return null;
  }
  return input.orgs.getOrCreateDefaultOrg(input.defaultOrg);
}

interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly status: OrgStatus;
  readonly tier: string;
  readonly plan_id: string;
  readonly region: string;
  readonly byo_config: JsonObject;
  readonly feature_flags: JsonObject;
  readonly quotas: JsonObject;
  readonly branding: JsonObject;
  readonly suspended_at: Date | null;
  readonly soft_deleted_at: Date | null;
  readonly hard_deleted_at: Date | null;
}

export class PostgresOrgStore implements OrgStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresOrgStoreOptions = {},
  ) {}

  async createOrg(input: CreateOrgInput): Promise<OrgRecord> {
    const id = input.id ?? randomUUID();
    const rows = (await this.sql`
      insert into orgs (
        id,
        slug,
        display_name,
        status,
        tier,
        plan_id,
        region,
        byo_config,
        feature_flags,
        quotas,
        branding
      )
      values (
        ${id},
        ${input.slug},
        ${input.displayName},
        ${input.status ?? "provisioning"},
        ${input.tier ?? "personal"},
        ${input.planId ?? "personal"},
        ${input.region ?? DEFAULT_ORG_REGION},
        ${this.sql.json(input.byoConfig ?? {})},
        ${this.sql.json(input.featureFlags ?? {})},
        ${this.sql.json(input.quotas ?? {})},
        ${this.sql.json(input.branding ?? {})}
      )
      returning
        id,
        slug,
        display_name,
        status,
        tier,
        plan_id,
        region,
        byo_config,
        feature_flags,
        quotas,
        branding,
        suspended_at,
        soft_deleted_at,
        hard_deleted_at
    `) as unknown as readonly OrgRow[];
    const org = mapOrgRow(rows[0]);
    await this.options.tenantRoleProvisioner?.ensureRoleForOrg(org.id);
    return org;
  }

  async getOrCreateDefaultOrg(input: DefaultOrgInput = {}): Promise<OrgRecord> {
    const id = input.id ?? DEFAULT_ORG_ID;
    const slug = input.slug ?? DEFAULT_ORG_SLUG;
    const displayName = input.displayName ?? DEFAULT_ORG_DISPLAY_NAME;
    const region = input.region ?? DEFAULT_ORG_REGION;
    const rows = (await this.sql`
      insert into orgs (id, slug, display_name, status, tier, plan_id, region)
      values (${id}, ${slug}, ${displayName}, 'active', 'personal', 'personal', ${region})
      on conflict (id) do update
        set updated_at = orgs.updated_at
      returning
        id,
        slug,
        display_name,
        status,
        tier,
        plan_id,
        region,
        byo_config,
        feature_flags,
        quotas,
        branding,
        suspended_at,
        soft_deleted_at,
        hard_deleted_at
    `) as unknown as readonly OrgRow[];
    const org = mapOrgRow(rows[0]);
    await this.options.tenantRoleProvisioner?.ensureRoleForOrg(org.id);
    return org;
  }

  async activateProvisionedOrg(id: string): Promise<OrgRecord | null> {
    const rows = (await this.sql`
      update orgs
      set
        status = 'active',
        updated_at = now()
      where id = ${id}
        and status = 'provisioning'
      returning
        id,
        slug,
        display_name,
        status,
        tier,
        plan_id,
        region,
        byo_config,
        feature_flags,
        quotas,
        branding,
        suspended_at,
        soft_deleted_at,
        hard_deleted_at
    `) as unknown as readonly OrgRow[];
    return rows[0] === undefined ? null : mapOrgRow(rows[0]);
  }

  async findById(id: string): Promise<OrgRecord | null> {
    const rows = (await this.sql`
      select
        id,
        slug,
        display_name,
        status,
        tier,
        plan_id,
        region,
        byo_config,
        feature_flags,
        quotas,
        branding,
        suspended_at,
        soft_deleted_at,
        hard_deleted_at
      from orgs
      where id = ${id}
      limit 1
    `) as unknown as readonly OrgRow[];
    return rows[0] === undefined ? null : mapOrgRow(rows[0]);
  }

  async findBySlug(slug: string): Promise<OrgRecord | null> {
    const rows = (await this.sql`
      select
        id,
        slug,
        display_name,
        status,
        tier,
        plan_id,
        region,
        byo_config,
        feature_flags,
        quotas,
        branding,
        suspended_at,
        soft_deleted_at,
        hard_deleted_at
      from orgs
      where slug = ${slug}
      limit 1
    `) as unknown as readonly OrgRow[];
    return rows[0] === undefined ? null : mapOrgRow(rows[0]);
  }

  async updateTenantConfig(input: UpdateTenantConfigInput): Promise<OrgRecord | null> {
    return this.sql.begin(async (tx) => {
      await tx`
        select
          set_config('helix.tenant_config_changed_by', ${input.changedByActorId ?? ""}, true),
          set_config('helix.tenant_config_reason', ${input.reason ?? "tenant-config:update"}, true)
      `;
      const rows = (await tx`
        update orgs
        set
          byo_config = case
            when ${input.byoConfig === undefined} then byo_config
            else ${tx.json(jsonObjectValue(input.byoConfig))}
          end,
          feature_flags = case
            when ${input.featureFlags === undefined} then feature_flags
            else ${tx.json(jsonObjectValue(input.featureFlags))}
          end,
          quotas = case
            when ${input.quotas === undefined} then quotas
            else ${tx.json(jsonObjectValue(input.quotas))}
          end,
          branding = case
            when ${input.branding === undefined} then branding
            else ${tx.json(jsonObjectValue(input.branding))}
          end,
          updated_at = now()
        where id = ${input.orgId}
        returning
          id,
          slug,
          display_name,
          status,
          tier,
          plan_id,
          region,
          byo_config,
          feature_flags,
          quotas,
          branding,
          suspended_at,
          soft_deleted_at,
          hard_deleted_at
      `) as unknown as readonly OrgRow[];
      return rows[0] === undefined ? null : mapOrgRow(rows[0]);
    });
  }

  async cutoverTenantStorageConfig(
    input: CutoverTenantStorageConfigInput,
  ): Promise<OrgRecord | null> {
    return this.sql.begin(async (tx) => {
      await tx`
        select
          set_config('helix.tenant_config_changed_by', ${input.changedByActorId ?? ""}, true),
          set_config('helix.tenant_config_reason', ${
            input.reason ?? "tenant-storage-migration:cutover"
          }, true)
      `;
      const expectedStorage =
        input.expectedCurrentStorage === null
          ? null
          : tx.json(jsonObjectValue(input.expectedCurrentStorage));
      const rows = (await tx`
        update orgs
        set
          byo_config = jsonb_set(
            byo_config,
            '{storage}',
            ${tx.json(jsonObjectValue(input.storageConfig))},
            true
          ),
          feature_flags = case
            when ${input.enableByoStorage === true} then jsonb_set(
              feature_flags,
              '{byo_storage}',
              'true'::jsonb,
              true
            )
            else feature_flags
          end,
          updated_at = now()
        where id = ${input.orgId}
          and byo_config->'storage' is not distinct from ${expectedStorage}::jsonb
        returning
          id,
          slug,
          display_name,
          status,
          tier,
          plan_id,
          region,
          byo_config,
          feature_flags,
          quotas,
          branding,
          suspended_at,
          soft_deleted_at,
          hard_deleted_at
      `) as unknown as readonly OrgRow[];
      return rows[0] === undefined ? null : mapOrgRow(rows[0]);
    });
  }

  async listByoStorageOrgIds(
    input: { readonly limit?: number | undefined } = {},
  ): Promise<readonly string[]> {
    const rows = (await this.sql`
      select id
      from orgs
      where status = 'active'
        and feature_flags->>'byo_storage' = 'true'
        and byo_config->'storage'->>'kind' = 'byo'
      order by updated_at asc
      limit ${input.limit ?? 100}
    `) as unknown as readonly { readonly id: string }[];
    return rows.map((row) => row.id);
  }

  async updateByoStorageHealth(input: UpdateByoStorageHealthInput): Promise<OrgRecord | null> {
    return this.sql.begin(async (tx) => {
      await tx`
        select set_config(
          'helix.tenant_config_reason',
          ${input.reason ?? "byo-storage-health:update"},
          true
        )
      `;
      const rows = (await tx`
        update orgs
        set
          byo_config = jsonb_set(
            byo_config,
            '{storage,health}',
            ${tx.json(jsonSerializable(input.health))},
            true
          ),
          updated_at = now()
        where id = ${input.orgId}
          and byo_config->'storage'->>'kind' = 'byo'
        returning
          id,
          slug,
          display_name,
          status,
          tier,
          plan_id,
          region,
          byo_config,
          feature_flags,
          quotas,
          branding,
          suspended_at,
          soft_deleted_at,
          hard_deleted_at
      `) as unknown as readonly OrgRow[];
      return rows[0] === undefined ? null : mapOrgRow(rows[0]);
    });
  }
}

function mapOrgRow(row: OrgRow | undefined): OrgRecord {
  if (row === undefined) {
    throw new Error("org query returned no rows");
  }
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status,
    tier: row.tier,
    planId: row.plan_id,
    region: row.region,
    byoConfig: row.byo_config,
    featureFlags: row.feature_flags,
    quotas: row.quotas,
    branding: row.branding,
    suspendedAt: row.suspended_at ?? null,
    softDeletedAt: row.soft_deleted_at ?? null,
    hardDeletedAt: row.hard_deleted_at ?? null,
  };
}

function jsonObjectValue(value: JsonObject | undefined): Parameters<postgres.Sql["json"]>[0] {
  return value ?? {};
}

function jsonSerializable(value: unknown): Parameters<postgres.Sql["json"]>[0] {
  return value as Parameters<postgres.Sql["json"]>[0];
}
