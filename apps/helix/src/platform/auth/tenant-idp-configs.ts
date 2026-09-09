import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { z } from "zod";

export type TenantIdpProtocol = "oidc";

const httpsUrl = z
  .string()
  .url()
  .refine(isCredentialFreeHttpsUrl, "Credential-free HTTPS URL required");
const oidcPublicConfig = z
  .object({
    issuer: httpsUrl.optional(),
    metadataUrl: httpsUrl.optional(),
    clientId: z.string().trim().min(1).max(500).optional(),
    scopes: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    authorizationEndpoint: httpsUrl.optional(),
    tokenEndpoint: httpsUrl.optional(),
    jwksUri: httpsUrl.optional(),
  })
  .strict();
const claimSelector = z
  .string()
  .trim()
  .max(1_000)
  .regex(/^\$\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u);
const idpAttributeMapping = z
  .object({
    email: claimSelector.optional(),
    displayName: claimSelector.optional(),
    givenName: claimSelector.optional(),
    familyName: claimSelector.optional(),
    groups: claimSelector.optional(),
    externalId: claimSelector.optional(),
  })
  .strict();

/** Only public protocol settings are allowed; credentials use the opaque secret handle. */
export function parseTenantIdpPublicConfig(
  _protocol: TenantIdpProtocol,
  value: unknown,
): JsonObject {
  return oidcPublicConfig.parse(value) as JsonObject;
}

export function parseTenantIdpAttributeMapping(value: unknown): JsonObject {
  return idpAttributeMapping.parse(value) as JsonObject;
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export interface TenantIdpConfigRecord {
  readonly id: string;
  readonly orgId: string;
  readonly protocol: TenantIdpProtocol;
  readonly isPrimary: boolean;
  readonly displayName: string;
  readonly config: JsonObject;
  readonly signingCertSecretHandle: string | null;
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
  readonly signingCertSecretHandle?: string | null | undefined;
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
  readonly signingCertSecretHandle?: string | null | undefined;
  readonly attrMapping?: JsonObject | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly jitProvisioning?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

export interface TenantIdpConfigStore {
  list(orgId: string): Promise<readonly TenantIdpConfigRecord[]>;
  get(orgId: string, id: string): Promise<TenantIdpConfigRecord | null>;
  getPrimary(orgId: string): Promise<TenantIdpConfigRecord | null>;
  runtimeReady(orgId: string, id: string): Promise<boolean>;
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
  readonly signing_cert_secret_handle: string | null;
  readonly attr_mapping: unknown;
  readonly jit_provisioning: boolean;
  readonly enabled: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresTenantIdpConfigStore implements TenantIdpConfigStore {
  constructor(private readonly sql: postgres.Sql) {}

  async list(orgId: string): Promise<readonly TenantIdpConfigRecord[]> {
    const rows = await this.sql<TenantIdpConfigRow[]>`
      select id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
             attr_mapping, jit_provisioning, enabled, created_at, updated_at
      from tenant_idp_configs
      where org_id = ${orgId}
        and protocol = 'oidc'
      order by is_primary desc, enabled desc, created_at desc, id asc
    `;
    return rows.map(mapTenantIdpConfigRow);
  }

  async get(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const rows = await this.sql<TenantIdpConfigRow[]>`
      select id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
             attr_mapping, jit_provisioning, enabled, created_at, updated_at
      from tenant_idp_configs
      where org_id = ${orgId}
        and id = ${id}
        and protocol = 'oidc'
      limit 1
    `;
    return rowOrNull(rows[0]);
  }

  async getPrimary(orgId: string): Promise<TenantIdpConfigRecord | null> {
    const rows = await this.sql<TenantIdpConfigRow[]>`
      select id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
             attr_mapping, jit_provisioning, enabled, created_at, updated_at
      from tenant_idp_configs
      where org_id = ${orgId}
        and protocol = 'oidc'
        and is_primary
        and enabled
      limit 1
    `;
    return rowOrNull(rows[0]);
  }

  async runtimeReady(orgId: string, id: string): Promise<boolean> {
    const rows = await this.sql<{ readonly ready: boolean }[]>`
      select exists (
        select 1 from "ssoProvider"
        where id = ${id} and "organizationId" = ${orgId}
      ) as ready
    `;
    return rows[0]?.ready === true;
  }

  async create(input: CreateTenantIdpConfigInput): Promise<TenantIdpConfigRecord> {
    const publicConfig = parseTenantIdpPublicConfig(input.protocol, input.config ?? {});
    const attrMapping = parseTenantIdpAttributeMapping(input.attrMapping ?? {});
    const rows = await this.sql<TenantIdpConfigRow[]>`
      insert into tenant_idp_configs (
        org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
        attr_mapping, jit_provisioning, enabled
      )
      values (
        ${input.orgId},
        ${input.protocol},
        ${input.isPrimary ?? true},
        ${input.displayName},
        ${this.sql.json(publicConfig)},
        ${input.signingCertSecretHandle ?? null},
        ${this.sql.json(attrMapping)},
        ${input.jitProvisioning ?? false},
        ${input.enabled ?? true}
      )
      returning id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
                attr_mapping, jit_provisioning, enabled, created_at, updated_at
    `;
    return mapTenantIdpConfigRow(rows[0]);
  }

  async update(input: UpdateTenantIdpConfigInput): Promise<TenantIdpConfigRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = await tx<TenantIdpConfigRow[]>`
        select id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
               attr_mapping, jit_provisioning, enabled, created_at, updated_at
        from tenant_idp_configs
        where org_id = ${input.orgId}
          and id = ${input.id}
        for update
        limit 1
      `;
      const existing = rowOrNull(existingRows[0]);
      if (existing === null) {
        return null;
      }

      const enabled = input.enabled ?? existing.enabled;
      const protocol = input.protocol ?? existing.protocol;
      const publicConfig = parseTenantIdpPublicConfig(protocol, input.config ?? existing.config);
      const attrMapping = parseTenantIdpAttributeMapping(input.attrMapping ?? existing.attrMapping);
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

      const updatedRows = await tx<TenantIdpConfigRow[]>`
        update tenant_idp_configs
        set protocol = ${protocol},
            is_primary = ${isPrimary},
            display_name = ${input.displayName ?? existing.displayName},
            config = ${tx.json(publicConfig)},
            signing_cert_secret_handle = ${
              input.signingCertSecretHandle === undefined
                ? existing.signingCertSecretHandle
                : input.signingCertSecretHandle
            },
            attr_mapping = ${tx.json(attrMapping)},
            jit_provisioning = ${input.jitProvisioning ?? existing.jitProvisioning},
            enabled = ${enabled},
            updated_at = now()
        where org_id = ${input.orgId}
          and id = ${input.id}
        returning id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
                  attr_mapping, jit_provisioning, enabled, created_at, updated_at
      `;
      return rowOrNull(updatedRows[0]);
    });
  }

  async delete(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const rows = await this.sql<TenantIdpConfigRow[]>`
      delete from tenant_idp_configs
      where org_id = ${orgId}
        and id = ${id}
      returning id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
                attr_mapping, jit_provisioning, enabled, created_at, updated_at
    `;
    return rowOrNull(rows[0]);
  }

  async setPrimary(orgId: string, id: string): Promise<TenantIdpConfigRecord | null> {
    const rows = await this.sql<TenantIdpConfigRow[]>`
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
      returning id, org_id, protocol, is_primary, display_name, config, signing_cert_secret_handle,
                attr_mapping, jit_provisioning, enabled, created_at, updated_at
    `;
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

  async runtimeReady(orgId: string, id: string): Promise<boolean> {
    const config = await this.get(orgId, id);
    return (
      config !== null &&
      config.enabled &&
      config.isPrimary &&
      config.signingCertSecretHandle !== null &&
      typeof config.config.issuer === "string" &&
      typeof config.config.clientId === "string"
    );
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
    const publicConfig = parseTenantIdpPublicConfig(input.protocol, input.config ?? {});
    const attrMapping = parseTenantIdpAttributeMapping(input.attrMapping ?? {});
    const record: TenantIdpConfigRecord = {
      id: `idp-${(this.#seq += 1).toString()}`,
      orgId: input.orgId,
      protocol: input.protocol,
      isPrimary: input.isPrimary ?? true,
      displayName: input.displayName,
      config: publicConfig,
      signingCertSecretHandle: input.signingCertSecretHandle ?? null,
      attrMapping,
      jitProvisioning: input.jitProvisioning ?? false,
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
    const protocol = input.protocol ?? existing.protocol;
    const publicConfig = parseTenantIdpPublicConfig(protocol, input.config ?? existing.config);
    const attrMapping = parseTenantIdpAttributeMapping(input.attrMapping ?? existing.attrMapping);
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
      protocol,
      displayName: input.displayName ?? existing.displayName,
      config: publicConfig,
      signingCertSecretHandle:
        input.signingCertSecretHandle === undefined
          ? existing.signingCertSecretHandle
          : input.signingCertSecretHandle,
      attrMapping,
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
  if (row.protocol !== "oidc") {
    throw new Error(`Unsupported tenant IdP protocol: ${row.protocol}`);
  }
  return {
    id: row.id,
    orgId: row.org_id,
    protocol: row.protocol,
    isPrimary: row.is_primary,
    displayName: row.display_name,
    config: parseTenantIdpPublicConfig(row.protocol, row.config),
    signingCertSecretHandle: row.signing_cert_secret_handle,
    attrMapping: parseTenantIdpAttributeMapping(row.attr_mapping),
    jitProvisioning: row.jit_provisioning,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowOrNull(row: TenantIdpConfigRow | undefined): TenantIdpConfigRecord | null {
  return row === undefined ? null : mapTenantIdpConfigRow(row);
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
