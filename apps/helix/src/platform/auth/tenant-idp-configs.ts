import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";

export type TenantIdpProtocol = "saml" | "oidc";

export interface TenantIdpConfigRecord {
  readonly id: string;
  readonly orgId: string;
  readonly protocol: TenantIdpProtocol;
  readonly isPrimary: boolean;
  readonly displayName: string;
  readonly config: JsonObject;
  readonly signingCertVaultPath: string | null;
  readonly attrMapping: JsonObject;
  readonly jitProvisioning: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTenantIdpConfigInput {
  readonly orgId: string;
  readonly protocol: TenantIdpProtocol;
  readonly displayName: string;
  readonly config?: JsonObject | undefined;
  readonly signingCertVaultPath?: string | null | undefined;
  readonly attrMapping?: JsonObject | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly jitProvisioning?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

export interface UpdateTenantIdpConfigInput {
  readonly orgId: string;
  readonly id: string;
  readonly protocol?: TenantIdpProtocol | undefined;
  readonly displayName?: string | undefined;
  readonly config?: JsonObject | undefined;
  readonly signingCertVaultPath?: string | null | undefined;
  readonly attrMapping?: JsonObject | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly jitProvisioning?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

export interface TenantIdpConfigStore {
  list(orgId: string): Promise<readonly TenantIdpConfigRecord[]>;
  get(orgId: string, id: string): Promise<TenantIdpConfigRecord | null>;
  getPrimary(orgId: string): Promise<TenantIdpConfigRecord | null>;
  create(input: CreateTenantIdpConfigInput): Promise<TenantIdpConfigRecord>;
  update(input: UpdateTenantIdpConfigInput): Promise<TenantIdpConfigRecord | null>;
  delete(orgId: string, id: string): Promise<TenantIdpConfigRecord | null>;
  setPrimary(orgId: string, id: string): Promise<TenantIdpConfigRecord | null>;
}

interface TenantIdpConfigRow {
  readonly id: string;
  readonly org_id: string;
  readonly protocol: string;
  readonly is_primary: boolean;
  readonly display_name: string;
  readonly config: unknown;
  readonly signing_cert_vault_path: string | null;
  readonly attr_mapping: unknown;
  readonly jit_provisioning: boolean;
  readonly enabled: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresTenantIdpConfigStore implements TenantIdpConfigStore {
  constructor(private readonly sql: postgres.Sql) {}

  async list(orgId: string): Promise<readonly TenantIdpConfigRecord[]> {
    const selectedRows = await this.sql`
      select id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
             attr_mapping, jit_provisioning, enabled, created_at, updated_at
      from tenant_idp_configs
      where org_id = ${orgId}
      order by is_primary desc, enabled desc, created_at desc, id asc
    `;
    const rows = selectedRows as unknown as readonly TenantIdpConfigRow[];
    return rows.map(mapTenantIdpConfigRow);
  }

  async get(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const selectedRows = await this.sql`
      select id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
             attr_mapping, jit_provisioning, enabled, created_at, updated_at
      from tenant_idp_configs
      where org_id = ${orgId}
        and id = ${id}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly TenantIdpConfigRow[];
    return rowOrNull(rows[0]);
  }

  async getPrimary(orgId: string): Promise<TenantIdpConfigRecord | null> {
    const selectedRows = await this.sql`
      select id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
             attr_mapping, jit_provisioning, enabled, created_at, updated_at
      from tenant_idp_configs
      where org_id = ${orgId}
        and is_primary
        and enabled
      limit 1
    `;
    const rows = selectedRows as unknown as readonly TenantIdpConfigRow[];
    return rowOrNull(rows[0]);
  }

  async create(input: CreateTenantIdpConfigInput): Promise<TenantIdpConfigRecord> {
    const insertedRows = await this.sql`
      insert into tenant_idp_configs (
        org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
        attr_mapping, jit_provisioning, enabled
      )
      values (
        ${input.orgId},
        ${input.protocol},
        ${input.isPrimary ?? true},
        ${input.displayName},
        ${this.sql.json(input.config ?? {})},
        ${input.signingCertVaultPath ?? null},
        ${this.sql.json(input.attrMapping ?? {})},
        ${input.jitProvisioning ?? true},
        ${input.enabled ?? true}
      )
      returning id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
                attr_mapping, jit_provisioning, enabled, created_at, updated_at
    `;
    const rows = insertedRows as unknown as readonly TenantIdpConfigRow[];
    return mapTenantIdpConfigRow(rows[0]);
  }

  async update(input: UpdateTenantIdpConfigInput): Promise<TenantIdpConfigRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = await tx`
        select id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
               attr_mapping, jit_provisioning, enabled, created_at, updated_at
        from tenant_idp_configs
        where org_id = ${input.orgId}
          and id = ${input.id}
        for update
        limit 1
      `;
      const existing = rowOrNull(existingRows[0] as TenantIdpConfigRow | undefined);
      if (existing === null) {
        return null;
      }

      const enabled = input.enabled ?? existing.enabled;
      const isPrimary = enabled && (input.isPrimary ?? existing.isPrimary);
      if (isPrimary) {
        await tx`
          update tenant_idp_configs
          set is_primary = false,
              updated_at = now()
          where org_id = ${input.orgId}
            and id <> ${input.id}
        `;
      }

      const updatedRows = await tx`
        update tenant_idp_configs
        set protocol = ${input.protocol ?? existing.protocol},
            is_primary = ${isPrimary},
            display_name = ${input.displayName ?? existing.displayName},
            config = ${tx.json(input.config ?? existing.config)},
            signing_cert_vault_path = ${
              input.signingCertVaultPath === undefined
                ? existing.signingCertVaultPath
                : input.signingCertVaultPath
            },
            attr_mapping = ${tx.json(input.attrMapping ?? existing.attrMapping)},
            jit_provisioning = ${input.jitProvisioning ?? existing.jitProvisioning},
            enabled = ${enabled},
            updated_at = now()
        where org_id = ${input.orgId}
          and id = ${input.id}
        returning id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
                  attr_mapping, jit_provisioning, enabled, created_at, updated_at
      `;
      return rowOrNull(updatedRows[0] as TenantIdpConfigRow | undefined);
    });
  }

  async delete(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const deletedRows = await this.sql`
      delete from tenant_idp_configs
      where org_id = ${orgId}
        and id = ${id}
      returning id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
                attr_mapping, jit_provisioning, enabled, created_at, updated_at
    `;
    const rows = deletedRows as unknown as readonly TenantIdpConfigRow[];
    return rowOrNull(rows[0]);
  }

  async setPrimary(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const updatedRows = await this.sql`
      with selected as (
        select id
        from tenant_idp_configs
        where org_id = ${orgId}
          and id = ${id}
          and enabled
      ),
      demoted as (
        update tenant_idp_configs
        set is_primary = false,
            updated_at = now()
        where org_id = ${orgId}
          and id <> ${id}
          and exists (select 1 from selected)
      )
      update tenant_idp_configs
      set is_primary = true,
          updated_at = now()
      where id in (select id from selected)
      returning id, org_id, protocol, is_primary, display_name, config, signing_cert_vault_path,
                attr_mapping, jit_provisioning, enabled, created_at, updated_at
    `;
    const rows = updatedRows as unknown as readonly TenantIdpConfigRow[];
    return rowOrNull(rows[0]);
  }
}

export class InMemoryTenantIdpConfigStore implements TenantIdpConfigStore {
  readonly #records = new Map<string, TenantIdpConfigRecord>();
  #seq = 0;

  constructor(private readonly options: { readonly now?: () => Date } = {}) {}

  async list(orgId: string): Promise<readonly TenantIdpConfigRecord[]> {
    return this.#orgRecords(orgId);
  }

  async get(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const record = this.#records.get(id);
    return record === undefined || record.orgId !== orgId ? null : record;
  }

  async getPrimary(orgId: string): Promise<TenantIdpConfigRecord | null> {
    return this.#orgRecords(orgId).find((record) => record.enabled && record.isPrimary) ?? null;
  }

  async create(input: CreateTenantIdpConfigInput): Promise<TenantIdpConfigRecord> {
    if (
      input.enabled !== false &&
      input.isPrimary !== false &&
      (await this.getPrimary(input.orgId)) !== null
    ) {
      throw new Error("Tenant already has an enabled primary IdP config.");
    }
    const now = this.#now();
    const record: TenantIdpConfigRecord = {
      id: `idp-${(this.#seq += 1).toString()}`,
      orgId: input.orgId,
      protocol: input.protocol,
      isPrimary: input.isPrimary ?? true,
      displayName: input.displayName,
      config: input.config ?? {},
      signingCertVaultPath: input.signingCertVaultPath ?? null,
      attrMapping: input.attrMapping ?? {},
      jitProvisioning: input.jitProvisioning ?? true,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.#records.set(record.id, record);
    return record;
  }

  async update(input: UpdateTenantIdpConfigInput): Promise<TenantIdpConfigRecord | null> {
    const existing = await this.get(input.orgId, input.id);
    if (existing === null) {
      return null;
    }
    const now = this.#now();
    const enabled = input.enabled ?? existing.enabled;
    const isPrimary = enabled && (input.isPrimary ?? existing.isPrimary);
    if (isPrimary) {
      for (const record of this.#orgRecords(input.orgId)) {
        if (record.id !== input.id) {
          this.#records.set(record.id, { ...record, isPrimary: false, updatedAt: now });
        }
      }
    }
    const updated: TenantIdpConfigRecord = {
      ...existing,
      protocol: input.protocol ?? existing.protocol,
      displayName: input.displayName ?? existing.displayName,
      config: input.config ?? existing.config,
      signingCertVaultPath:
        input.signingCertVaultPath === undefined
          ? existing.signingCertVaultPath
          : input.signingCertVaultPath,
      attrMapping: input.attrMapping ?? existing.attrMapping,
      isPrimary,
      jitProvisioning: input.jitProvisioning ?? existing.jitProvisioning,
      enabled,
      updatedAt: now,
    };
    this.#records.set(updated.id, updated);
    return updated;
  }

  async delete(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const existing = await this.get(orgId, id);
    if (existing === null) {
      return null;
    }
    this.#records.delete(id);
    return existing;
  }

  async setPrimary(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const target = this.#records.get(id);
    if (target === undefined || target.orgId !== orgId || !target.enabled) {
      return null;
    }
    const now = this.#now();
    for (const record of this.#orgRecords(orgId)) {
      this.#records.set(record.id, {
        ...record,
        isPrimary: record.id === id,
        updatedAt: now,
      });
    }
    return this.#records.get(id) ?? null;
  }

  #orgRecords(orgId: string): readonly TenantIdpConfigRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.orgId === orgId)
      .sort(compareTenantIdpConfigs);
  }

  #now(): string {
    return (this.options.now ?? (() => new Date("2026-05-24T00:00:00.000Z")))().toISOString();
  }
}

function mapTenantIdpConfigRow(row: TenantIdpConfigRow | undefined): TenantIdpConfigRecord {
  if (row === undefined) {
    throw new Error("Tenant IdP config query returned no rows.");
  }
  if (row.protocol !== "saml" && row.protocol !== "oidc") {
    throw new Error(`Unsupported tenant IdP protocol: ${row.protocol}`);
  }
  return {
    id: row.id,
    orgId: row.org_id,
    protocol: row.protocol,
    isPrimary: row.is_primary,
    displayName: row.display_name,
    config: jsonObjectOrEmpty(row.config),
    signingCertVaultPath: row.signing_cert_vault_path,
    attrMapping: jsonObjectOrEmpty(row.attr_mapping),
    jitProvisioning: row.jit_provisioning,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowOrNull(row: TenantIdpConfigRow | undefined): TenantIdpConfigRecord | null {
  return row === undefined ? null : mapTenantIdpConfigRow(row);
}

function jsonObjectOrEmpty(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function compareTenantIdpConfigs(
  left: TenantIdpConfigRecord,
  right: TenantIdpConfigRecord,
): number {
  if (left.isPrimary !== right.isPrimary) {
    return left.isPrimary ? -1 : 1;
  }
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}
