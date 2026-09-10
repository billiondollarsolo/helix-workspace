import type postgres from "postgres";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { isUniqueViolation } from "../util/sql.js";
type ScimFilterAttribute = "id" | "externalId" | "userName" | "displayName";
export interface ScimFilter {
  readonly attribute: ScimFilterAttribute;
  readonly value: string;
}
export interface ScimPage<T> {
  readonly resources: readonly T[];
  readonly total: number;
}
export interface ScimUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly externalId: string | null;
  readonly userName: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly active: boolean;
  readonly dataTransferTargetId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}
interface ScimGroupMember {
  readonly value: string;
  readonly display: string;
}
export interface ScimGroupRecord {
  readonly id: string;
  readonly orgId: string;
  readonly externalId: string | null;
  readonly displayName: string;
  readonly members: readonly ScimGroupMember[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}
export interface PutScimUser {
  readonly externalId: string | null;
  readonly userName: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly active: boolean;
  readonly dataTransferTargetId?: string | null | undefined;
}
export interface PutScimGroup {
  readonly externalId: string | null;
  readonly displayName: string;
  readonly memberIds: readonly string[];
}
export interface ScimWriteResult<T> {
  readonly record: T;
  readonly created: boolean;
}
export interface ScimProvisioningStore {
  listUsers(
    orgId: string,
    filter: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<ScimPage<ScimUserRecord>>;
  getUser(orgId: string, id: string): Promise<ScimUserRecord | null>;
  createUser(orgId: string, input: PutScimUser): Promise<ScimWriteResult<ScimUserRecord>>;
  putUser(
    orgId: string,
    id: string,
    input: PutScimUser,
    expectedVersion: number | null,
  ): Promise<ScimUserRecord | null>;
  deleteUser(
    orgId: string,
    id: string,
    expectedVersion: number | null,
    transferToActorId: string | null,
  ): Promise<boolean>;
  listGroups(
    orgId: string,
    filter: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<ScimPage<ScimGroupRecord>>;
  getGroup(orgId: string, id: string): Promise<ScimGroupRecord | null>;
  createGroup(orgId: string, input: PutScimGroup): Promise<ScimWriteResult<ScimGroupRecord>>;
  putGroup(
    orgId: string,
    id: string,
    input: PutScimGroup,
    expectedVersion: number | null,
  ): Promise<ScimGroupRecord | null>;
  deleteGroup(orgId: string, id: string, expectedVersion: number | null): Promise<boolean>;
}
export class ScimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScimConflictError";
  }
}
export class ScimPreconditionError extends Error {
  constructor() {
    super("The resource changed after the supplied ETag was issued.");
    this.name = "ScimPreconditionError";
  }
}
interface UserRow {
  readonly id: string;
  readonly org_id: string;
  readonly external_id: string | null;
  readonly email: string;
  readonly display_name: string;
  readonly given_name: string | null;
  readonly family_name: string | null;
  readonly active: boolean;
  readonly transfer_target_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: string | number;
  readonly total_count?: string | number | undefined;
}
interface GroupRow {
  readonly id: string;
  readonly org_id: string;
  readonly external_id: string | null;
  readonly display_name: string;
  readonly members: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: string | number;
  readonly total_count?: string | number | undefined;
}
export class PostgresScimProvisioningStore implements ScimProvisioningStore {
  constructor(private readonly sql: postgres.Sql) {}
  async listUsers(
    orgId: string,
    filter: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<ScimPage<ScimUserRecord>> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<UserRow[]>`
        select id, org_id, scim_external_id as external_id, email,
               display_name, metadata #>> '{scim,givenName}' as given_name,
               metadata #>> '{scim,familyName}' as family_name,
               disabled_at is null as active,
               metadata #>> '{scim,dataTransferTargetId}' as transfer_target_id,
               created_at, updated_at, scim_version as version,
               count(*) over () as total_count
        from actors
        where org_id = ${orgId} and type = 'user' and email is not null
          and (
            ${filter === null}
            or (${filter?.attribute === "id"} and id::text = ${filter?.value ?? ""})
            or (${filter?.attribute === "externalId"} and lower(scim_external_id) = lower(${filter?.value ?? ""}))
            or (${filter?.attribute === "userName"} and lower(email) = lower(${filter?.value ?? ""}))
          )
        order by created_at, id
        offset ${offset} limit ${limit}
      `;
      return {
        resources: rows.map(mapUserRow),
        total: rows.length > 0 ? countFromRows(rows) : await countUsers(tx, orgId, filter),
      };
    });
  }
  async getUser(orgId: string, id: string): Promise<ScimUserRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId }, (tx) => selectUser(tx, orgId, id));
  }
  async createUser(orgId: string, input: PutScimUser): Promise<ScimWriteResult<ScimUserRecord>> {
    try {
      return await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
        const rows = await tx<UserRow[]>`
          insert into actors (
            org_id, type, email, display_name, disabled_at, scim_external_id, metadata
          ) values (
            ${orgId}, 'user', ${input.userName}, ${input.displayName},
            ${input.active ? null : new Date()}, ${input.externalId},
            ${JSON.stringify(scimMetadata(input))}::jsonb
          )
          returning id, org_id, scim_external_id as external_id, email,
                    display_name, metadata #>> '{scim,givenName}' as given_name,
                    metadata #>> '{scim,familyName}' as family_name,
                    disabled_at is null as active,
                    metadata #>> '{scim,dataTransferTargetId}' as transfer_target_id,
                    created_at, updated_at, scim_version as version
        `;
        return { record: mapRequiredUserRow(rows[0]), created: true };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findUserByCorrelation(orgId, input);
      if (existing !== null && sameUser(existing, input)) {
        return { record: existing, created: false };
      }
      throw new ScimConflictError("userName and externalId must be unique within the tenant.");
    }
  }
  async putUser(
    orgId: string,
    id: string,
    input: PutScimUser,
    expectedVersion: number | null,
  ): Promise<ScimUserRecord | null> {
    try {
      return await withTenantPostgresContext(this.sql, { orgId }, (tx) =>
        this.putUserInTransaction(tx, orgId, id, input, expectedVersion),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScimConflictError("userName and externalId must be unique within the tenant.");
      }
      throw error;
    }
  }
  async deleteUser(
    orgId: string,
    id: string,
    expectedVersion: number | null,
    transferToActorId: string | null,
  ): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const current = await selectUser(tx, orgId, id, true);
      if (current === null) return false;
      assertVersion(current.version, expectedVersion);
      await deprovisionUser(tx, orgId, id, transferToActorId);
      await tx`
        update actors
        set disabled_at = coalesce(disabled_at, now()),
            metadata = jsonb_set(
              metadata, '{scim}',
              coalesce(metadata->'scim', '{}'::jsonb) ||
                jsonb_build_object('dataTransferTargetId', ${transferToActorId}),
              true
            )
        where org_id = ${orgId} and id = ${id}
      `;
      return true;
    });
  }
  async listGroups(
    orgId: string,
    filter: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<ScimPage<ScimGroupRecord>> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<GroupRow[]>`
        select g.id, g.org_id, g.scim_external_id as external_id,
               g.name as display_name, g.created_at, g.updated_at,
               g.scim_version as version, count(*) over () as total_count,
               coalesce((
                 select jsonb_agg(jsonb_build_object('value', a.id, 'display', a.display_name)
                                  order by a.display_name, a.id)
                 from admin_group_members gm
                 join actors a on a.org_id = gm.org_id and a.id = gm.actor_id
                 where gm.org_id = g.org_id and gm.group_id = g.id
               ), '[]'::jsonb) as members
        from admin_groups g
        where g.org_id = ${orgId}
          and (
            ${filter === null}
            or (${filter?.attribute === "id"} and g.id::text = ${filter?.value ?? ""})
            or (${filter?.attribute === "externalId"} and lower(g.scim_external_id) = lower(${filter?.value ?? ""}))
            or (${filter?.attribute === "displayName"} and lower(g.name) = lower(${filter?.value ?? ""}))
          )
        order by g.created_at, g.id
        offset ${offset} limit ${limit}
      `;
      return {
        resources: rows.map(mapGroupRow),
        total: rows.length > 0 ? countFromRows(rows) : await countGroups(tx, orgId, filter),
      };
    });
  }
  async getGroup(orgId: string, id: string): Promise<ScimGroupRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId }, (tx) => selectGroup(tx, orgId, id));
  }
  async createGroup(orgId: string, input: PutScimGroup): Promise<ScimWriteResult<ScimGroupRecord>> {
    try {
      const record = await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
        await requireMembers(tx, orgId, input.memberIds);
        const rows = await tx<
          {
            readonly id: string;
          }[]
        >`
          insert into admin_groups (org_id, name, kind, scim_external_id)
          values (${orgId}, ${input.displayName}, 'group', ${input.externalId})
          returning id
        `;
        const id = rows[0]?.id;
        if (id === undefined) throw new Error("SCIM group insert returned no row.");
        await replaceMembers(tx, orgId, id, input.memberIds);
        const created = await selectGroup(tx, orgId, id);
        if (created === null) throw new Error("SCIM group disappeared after creation.");
        return created;
      });
      return { record, created: true };
    } catch (error) {
      if (error instanceof ScimConflictError) throw error;
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findGroupByCorrelation(orgId, input);
      if (existing !== null && sameGroup(existing, input)) {
        return { record: existing, created: false };
      }
      throw new ScimConflictError("displayName and externalId must be unique within the tenant.");
    }
  }
  async putGroup(
    orgId: string,
    id: string,
    input: PutScimGroup,
    expectedVersion: number | null,
  ): Promise<ScimGroupRecord | null> {
    try {
      return await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
        await requireMembers(tx, orgId, input.memberIds);
        const rows = await tx<
          {
            readonly id: string;
          }[]
        >`
          update admin_groups
          set name = ${input.displayName}, scim_external_id = ${input.externalId}
          where org_id = ${orgId} and id = ${id}
            and (${expectedVersion === null} or scim_version = ${expectedVersion ?? 0})
          returning id
        `;
        if (rows[0] === undefined) {
          const current = await selectGroup(tx, orgId, id);
          if (current !== null && expectedVersion !== null) throw new ScimPreconditionError();
          return null;
        }
        await replaceMembers(tx, orgId, id, input.memberIds);
        return selectGroup(tx, orgId, id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScimConflictError("displayName and externalId must be unique within the tenant.");
      }
      throw error;
    }
  }
  async deleteGroup(orgId: string, id: string, expectedVersion: number | null): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<
        {
          readonly id: string;
        }[]
      >`
        delete from admin_groups
        where org_id = ${orgId} and id = ${id}
          and (${expectedVersion === null} or scim_version = ${expectedVersion ?? 0})
        returning id
      `;
      if (rows[0] !== undefined) return true;
      const current = await selectGroup(tx, orgId, id);
      if (current !== null && expectedVersion !== null) throw new ScimPreconditionError();
      return false;
    });
  }
  private async putUserInTransaction(
    tx: postgres.TransactionSql,
    orgId: string,
    id: string,
    input: PutScimUser,
    expectedVersion: number | null,
  ): Promise<ScimUserRecord | null> {
    const current = await selectUser(tx, orgId, id, true);
    if (current === null) return null;
    assertVersion(current.version, expectedVersion);
    if (!input.active) {
      await deprovisionUser(tx, orgId, id, input.dataTransferTargetId ?? null);
    }
    try {
      const rows = await tx<UserRow[]>`
        update actors
        set email = ${input.userName}, display_name = ${input.displayName},
            disabled_at = ${input.active ? null : new Date()},
            scim_external_id = ${input.externalId},
            metadata = jsonb_set(metadata, '{scim}', ${JSON.stringify(scimMetadata(input))}::jsonb, true)
        where org_id = ${orgId} and id = ${id} and type = 'user'
        returning id, org_id, scim_external_id as external_id, email,
                  display_name, metadata #>> '{scim,givenName}' as given_name,
                  metadata #>> '{scim,familyName}' as family_name,
                  disabled_at is null as active,
                  metadata #>> '{scim,dataTransferTargetId}' as transfer_target_id,
                  created_at, updated_at, scim_version as version
      `;
      await tx`
        update "user" as auth_user
        set email = ${input.userName}, name = ${input.displayName}, "updatedAt" = now()
        from identity_provider_subjects provider_subject
        join organization_memberships membership
          on membership.subject_id = provider_subject.subject_id
        where provider_subject.provider = 'better-auth'
          and provider_subject.provider_subject = auth_user.id
          and membership.org_id = ${orgId}
          and membership.actor_id = ${id}
      `;
      await tx`
        update identity_subjects subject
        set canonical_email = lower(btrim(${input.userName})), updated_at = now()
        from organization_memberships membership
        where membership.subject_id = subject.id
          and membership.org_id = ${orgId}
          and membership.actor_id = ${id}
      `;
      await tx`
        update organization_memberships
        set status = ${input.active ? "active" : "deprovisioned"},
            suspended_at = null,
            ended_at = ${input.active ? null : new Date()},
            updated_at = now()
        where org_id = ${orgId} and actor_id = ${id}
      `;
      return rows[0] === undefined ? null : mapUserRow(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScimConflictError("userName and externalId must be unique within the tenant.");
      }
      throw error;
    }
  }
  private async findUserByCorrelation(
    orgId: string,
    input: PutScimUser,
  ): Promise<ScimUserRecord | null> {
    const page = await this.listUsers(
      orgId,
      input.externalId === null
        ? { attribute: "userName", value: input.userName }
        : { attribute: "externalId", value: input.externalId },
      0,
      2,
    );
    return page.resources[0] ?? null;
  }
  private async findGroupByCorrelation(
    orgId: string,
    input: PutScimGroup,
  ): Promise<ScimGroupRecord | null> {
    const page = await this.listGroups(
      orgId,
      input.externalId === null
        ? { attribute: "displayName", value: input.displayName }
        : { attribute: "externalId", value: input.externalId },
      0,
      2,
    );
    return page.resources[0] ?? null;
  }
}
type SqlLike = postgres.Sql | postgres.TransactionSql;
async function countUsers(sql: SqlLike, orgId: string, filter: ScimFilter | null): Promise<number> {
  const rows = await sql<
    {
      readonly count: string | number;
    }[]
  >`
    select count(*) as count from actors
    where org_id = ${orgId} and type = 'user' and email is not null
      and (
        ${filter === null}
        or (${filter?.attribute === "id"} and id::text = ${filter?.value ?? ""})
        or (${filter?.attribute === "externalId"} and lower(scim_external_id) = lower(${filter?.value ?? ""}))
        or (${filter?.attribute === "userName"} and lower(email) = lower(${filter?.value ?? ""}))
      )
  `;
  return Number(rows[0]?.count ?? 0);
}
async function countGroups(
  sql: SqlLike,
  orgId: string,
  filter: ScimFilter | null,
): Promise<number> {
  const rows = await sql<
    {
      readonly count: string | number;
    }[]
  >`
    select count(*) as count from admin_groups
    where org_id = ${orgId}
      and (
        ${filter === null}
        or (${filter?.attribute === "id"} and id::text = ${filter?.value ?? ""})
        or (${filter?.attribute === "externalId"} and lower(scim_external_id) = lower(${filter?.value ?? ""}))
        or (${filter?.attribute === "displayName"} and lower(name) = lower(${filter?.value ?? ""}))
      )
  `;
  return Number(rows[0]?.count ?? 0);
}
async function selectUser(
  sql: SqlLike,
  orgId: string,
  id: string,
  lock = false,
): Promise<ScimUserRecord | null> {
  const rows = await sql<UserRow[]>`
    select id, org_id, scim_external_id as external_id, email,
           display_name, metadata #>> '{scim,givenName}' as given_name,
           metadata #>> '{scim,familyName}' as family_name,
           disabled_at is null as active,
           metadata #>> '{scim,dataTransferTargetId}' as transfer_target_id,
           created_at, updated_at, scim_version as version
    from actors
    where org_id = ${orgId} and id = ${id} and type = 'user' and email is not null
    ${lock ? sql`for update` : sql``}
  `;
  return rows[0] === undefined ? null : mapUserRow(rows[0]);
}
async function selectGroup(
  sql: SqlLike,
  orgId: string,
  id: string,
): Promise<ScimGroupRecord | null> {
  const rows = await sql<GroupRow[]>`
    select g.id, g.org_id, g.scim_external_id as external_id,
           g.name as display_name, g.created_at, g.updated_at,
           g.scim_version as version,
           coalesce((
             select jsonb_agg(jsonb_build_object('value', a.id, 'display', a.display_name)
                              order by a.display_name, a.id)
             from admin_group_members gm
             join actors a on a.org_id = gm.org_id and a.id = gm.actor_id
             where gm.org_id = g.org_id and gm.group_id = g.id
           ), '[]'::jsonb) as members
    from admin_groups g
    where g.org_id = ${orgId} and g.id = ${id}
  `;
  return rows[0] === undefined ? null : mapGroupRow(rows[0]);
}
async function requireMembers(
  sql: SqlLike,
  orgId: string,
  memberIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return;
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    select id from actors
    where org_id = ${orgId} and type = 'user' and disabled_at is null
      and id in ${sql(unique)}
  `;
  if (rows.length !== unique.length) {
    throw new ScimConflictError("Every group member must be an active user in the same tenant.");
  }
}
async function replaceMembers(
  sql: SqlLike,
  orgId: string,
  groupId: string,
  memberIds: readonly string[],
): Promise<void> {
  await sql`delete from admin_group_members where org_id = ${orgId} and group_id = ${groupId}`;
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return;
  await sql`
    insert into admin_group_members (org_id, group_id, actor_id, role)
    select ${orgId}, ${groupId}, id, 'member'
    from actors
    where org_id = ${orgId} and id in ${sql(unique)} and disabled_at is null
  `;
}
async function deprovisionUser(
  tx: postgres.TransactionSql,
  orgId: string,
  actorId: string,
  transferToActorId: string | null,
): Promise<void> {
  if (transferToActorId === actorId) {
    throw new ScimConflictError("Data cannot be transferred to the deprovisioned user.");
  }
  if (transferToActorId !== null) {
    const target = await tx<
      {
        readonly id: string;
      }[]
    >`
      select id from actors
      where org_id = ${orgId} and id = ${transferToActorId}
        and type = 'user' and disabled_at is null
      for update
    `;
    if (target[0] === undefined) {
      throw new ScimConflictError(
        "The data-transfer target must be an active user in the same tenant.",
      );
    }
    await tx`
      insert into cal_calendar_memberships (
        org_id, calendar_id, actor_id, role, visible, sort_order
      )
      select org_id, id, ${transferToActorId}, 'owner', true, 0
      from cal_calendars
      where org_id = ${orgId} and owner_actor_id = ${actorId}
      on conflict (actor_id, calendar_id) do update
        set role = 'owner', updated_at = now()
    `;
    await tx`update objects set owner_actor_id = ${transferToActorId}, updated_at = now()
             where org_id = ${orgId} and owner_actor_id = ${actorId}
               and kind <> 'mail_source'`;
    await tx`update drive_folders set owner_actor_id = ${transferToActorId}, updated_at = now()
             where org_id = ${orgId} and owner_actor_id = ${actorId}`;
    await tx`update cal_calendars set owner_actor_id = ${transferToActorId}, updated_at = now()
             where org_id = ${orgId} and owner_actor_id = ${actorId}`;
    await tx`update vector_items set owner_actor_id = ${transferToActorId}, updated_at = now()
             where org_id = ${orgId} and owner_actor_id = ${actorId}`;
    await tx`update carddav_contacts set owner_actor_id = ${transferToActorId}, updated_at = now()
             where org_id = ${orgId} and owner_actor_id = ${actorId}`;
  }
  await tx`delete from admin_group_members where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`delete from permissions where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`delete from cal_calendar_memberships where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`
    update pending_actions
    set status = 'cancelled', decided_at = now(), error = 'Actor deprovisioned by SCIM'
    where org_id = ${orgId} and actor_id = ${actorId} and status = 'pending_confirmation'
  `;
  await tx`
    update organization_memberships
    set status = 'deprovisioned', suspended_at = null,
        ended_at = coalesce(ended_at, now()), updated_at = now()
    where org_id = ${orgId} and actor_id = ${actorId}
  `;
  await tx`update app_passwords set revoked_at = coalesce(revoked_at, now())
           where actor_id = ${actorId}`;
  await tx`update agent_credentials set revoked_at = coalesce(revoked_at, now()),
             revocation_epoch = revocation_epoch + 1 where actor_id = ${actorId}`;
  await tx`update oauth_access_tokens set revoked_at = coalesce(revoked_at, now())
           where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`update oauth_refresh_tokens set revoked_at = coalesce(revoked_at, now())
           where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`update oauth_grants set revoked_at = coalesce(revoked_at, now()), updated_at = now()
           where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`delete from oauth_authorization_codes where org_id = ${orgId} and actor_id = ${actorId}`;
  await tx`delete from oauth_consent_nonces where org_id = ${orgId} and actor_id = ${actorId}`;
}
function scimMetadata(input: PutScimUser): Record<string, unknown> {
  return {
    givenName: input.givenName,
    familyName: input.familyName,
    ...(input.dataTransferTargetId === undefined
      ? {}
      : { dataTransferTargetId: input.dataTransferTargetId }),
  };
}
function mapUserRow(row: UserRow): ScimUserRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    externalId: row.external_id,
    userName: row.email,
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    active: row.active,
    dataTransferTargetId: row.transfer_target_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}
function mapRequiredUserRow(row: UserRow | undefined): ScimUserRecord {
  if (row === undefined) throw new Error("SCIM user insert returned no row.");
  return mapUserRow(row);
}
function mapGroupRow(row: GroupRow): ScimGroupRecord {
  const members = Array.isArray(row.members)
    ? row.members.flatMap((member) => {
        if (typeof member !== "object" || member === null) return [];
        const candidate = member as Record<string, unknown>;
        const value = candidate.value;
        const display = candidate.display;
        return typeof value === "string" && typeof display === "string" ? [{ value, display }] : [];
      })
    : [];
  return {
    id: row.id,
    orgId: row.org_id,
    externalId: row.external_id,
    displayName: row.display_name,
    members,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}
function countFromRows(rows: readonly (UserRow | GroupRow)[]): number {
  return rows[0]?.total_count === undefined ? 0 : Number(rows[0].total_count);
}
function sameUser(record: ScimUserRecord, input: PutScimUser): boolean {
  return (
    record.externalId === input.externalId &&
    record.userName.toLowerCase() === input.userName.toLowerCase() &&
    record.displayName === input.displayName &&
    record.givenName === input.givenName &&
    record.familyName === input.familyName &&
    record.active === input.active
  );
}
function sameGroup(record: ScimGroupRecord, input: PutScimGroup): boolean {
  return (
    record.externalId === input.externalId &&
    record.displayName === input.displayName &&
    [...record.members.map((member) => member.value)].sort().join("\0") ===
      [...new Set(input.memberIds)].sort().join("\0")
  );
}
function assertVersion(actual: number, expected: number | null): void {
  if (expected !== null && actual !== expected) throw new ScimPreconditionError();
}
