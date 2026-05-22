import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "./console-shared.js";

/**
 * Admin Console — Groups & Organizational Units.
 *
 *  - Org units form a tree (`parentId` -> another unit, NULL at the root).
 *  - Groups are flat membership collections (mailing lists / security groups).
 *  - Membership is the (group, actor) join with a per-member role.
 *
 * Routes are mounted under `/api/admin/groups` and `/api/admin/org-units`,
 * gated by `admin.console.read` / `admin.console.write`, and audited.
 */

// --------------------------------------------------------------------------
// Records
// --------------------------------------------------------------------------

export type GroupKind = "group" | "security" | "mailing_list";
export type GroupMemberRole = "member" | "manager" | "owner";

export interface OrgUnitRecord {
  readonly id: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly memberCount: number;
  readonly childCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly email: string | null;
  readonly kind: GroupKind;
  readonly description: string;
  readonly orgUnitId: string | null;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupMemberRecord {
  readonly id: string;
  readonly orgId: string;
  readonly groupId: string;
  readonly actorId: string;
  readonly role: GroupMemberRole;
  readonly createdAt: string;
}

// --------------------------------------------------------------------------
// Store inputs
// --------------------------------------------------------------------------

export interface CreateOrgUnitInput {
  readonly orgId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly description: string;
  readonly createdBy: string;
}

export interface UpdateOrgUnitInput {
  readonly orgId: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly parentId?: string | null | undefined;
}

export interface CreateGroupInput {
  readonly orgId: string;
  readonly name: string;
  readonly email: string | null;
  readonly kind: GroupKind;
  readonly description: string;
  readonly orgUnitId: string | null;
  readonly createdBy: string;
}

export interface UpdateGroupInput {
  readonly orgId: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly email?: string | null | undefined;
  readonly kind?: GroupKind | undefined;
  readonly description?: string | undefined;
  readonly orgUnitId?: string | null | undefined;
}

export interface AddGroupMemberInput {
  readonly orgId: string;
  readonly groupId: string;
  readonly actorId: string;
  readonly role: GroupMemberRole;
  readonly addedBy: string;
}

/**
 * Persistence contract. Implemented by {@link PostgresGroupsStore} (production)
 * and {@link InMemoryGroupsStore} (tests / offline).
 */
export interface GroupsStore {
  listOrgUnits(orgId: string): Promise<readonly OrgUnitRecord[]>;
  getOrgUnit(orgId: string, id: string): Promise<OrgUnitRecord | null>;
  createOrgUnit(input: CreateOrgUnitInput): Promise<OrgUnitRecord>;
  updateOrgUnit(input: UpdateOrgUnitInput): Promise<OrgUnitRecord | null>;
  deleteOrgUnit(orgId: string, id: string): Promise<"deleted" | "not_found" | "has_children">;

  listGroups(orgId: string): Promise<readonly GroupRecord[]>;
  getGroup(orgId: string, id: string): Promise<GroupRecord | null>;
  createGroup(input: CreateGroupInput): Promise<GroupRecord>;
  updateGroup(input: UpdateGroupInput): Promise<GroupRecord | null>;
  deleteGroup(orgId: string, id: string): Promise<boolean>;

  listGroupMembers(orgId: string, groupId: string): Promise<readonly GroupMemberRecord[]>;
  addGroupMember(input: AddGroupMemberInput): Promise<GroupMemberRecord>;
  removeGroupMember(orgId: string, groupId: string, actorId: string): Promise<boolean>;
}

/** Thrown by stores when a uniqueness or referential rule is violated. */
export class GroupsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupsConflictError";
  }
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const uuid = z.string().uuid();
const groupKindSchema = z.enum(["group", "security", "mailing_list"]);
const groupMemberRoleSchema = z.enum(["member", "manager", "owner"]);
const nameSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(2000).default("");

const createOrgUnitBody = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    parentId: uuid.nullable().default(null),
  })
  .strict();

const updateOrgUnitBody = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    parentId: uuid.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

const createGroupBody = z
  .object({
    name: nameSchema,
    email: z.string().trim().email().max(320).nullable().default(null),
    kind: groupKindSchema.default("group"),
    description: descriptionSchema,
    orgUnitId: uuid.nullable().default(null),
  })
  .strict();

const updateGroupBody = z
  .object({
    name: nameSchema.optional(),
    email: z.string().trim().email().max(320).nullable().optional(),
    kind: groupKindSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    orgUnitId: uuid.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

const addMemberBody = z
  .object({
    actorId: uuid,
    role: groupMemberRoleSchema.default("member"),
  })
  .strict();

const idParams = z.object({ id: uuid });
const groupMemberParams = z.object({ id: uuid, actorId: uuid });

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

export interface RegisterAdminGroupsRoutesOptions {
  readonly store: GroupsStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
}

/**
 * Register the Groups & OUs admin routes:
 *
 *   GET    /api/admin/org-units
 *   POST   /api/admin/org-units
 *   PATCH  /api/admin/org-units/:id
 *   DELETE /api/admin/org-units/:id
 *   GET    /api/admin/groups
 *   POST   /api/admin/groups
 *   PATCH  /api/admin/groups/:id
 *   DELETE /api/admin/groups/:id
 *   GET    /api/admin/groups/:id/members
 *   POST   /api/admin/groups/:id/members
 *   DELETE /api/admin/groups/:id/members/:actorId
 */
export async function registerAdminGroupsRoutes(
  app: FastifyInstance,
  options: RegisterAdminGroupsRoutesOptions,
): Promise<void> {
  const { store, actorFromRequest, auditSink } = options;

  // ---- Org units ----------------------------------------------------------

  app.get("/api/admin/org-units", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { orgUnits: await store.listOrgUnits(actor.orgId) };
  });

  app.post("/api/admin/org-units", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createOrgUnitBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid org unit.", body.error.issues));
    }
    let orgUnit: OrgUnitRecord;
    try {
      orgUnit = await store.createOrgUnit({
        orgId: actor.orgId,
        parentId: body.data.parentId,
        name: body.data.name,
        description: body.data.description,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof GroupsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.org_unit.created",
      objectType: "admin_org_unit",
      objectId: orgUnit.id,
      metadata: { name: orgUnit.name, parentId: orgUnit.parentId },
    });
    return reply.code(201).send({ orgUnit });
  });

  app.patch("/api/admin/org-units/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid org unit id."));
    }
    const body = updateOrgUnitBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid org unit update.", body.error.issues));
    }
    let orgUnit: OrgUnitRecord | null;
    try {
      orgUnit = await store.updateOrgUnit({
        orgId: actor.orgId,
        id: params.data.id,
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
        ...(body.data.parentId === undefined ? {} : { parentId: body.data.parentId }),
      });
    } catch (error) {
      if (error instanceof GroupsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    if (orgUnit === null) {
      return reply.code(404).send(notFound("Org unit not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.org_unit.updated",
      objectType: "admin_org_unit",
      objectId: orgUnit.id,
      metadata: { fields: Object.keys(body.data) },
    });
    return { orgUnit };
  });

  app.delete("/api/admin/org-units/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid org unit id."));
    }
    const result = await store.deleteOrgUnit(actor.orgId, params.data.id);
    if (result === "not_found") {
      return reply.code(404).send(notFound("Org unit not found."));
    }
    if (result === "has_children") {
      return reply
        .code(409)
        .send(conflict("Org unit has child units; delete or reparent them first."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.org_unit.deleted",
      objectType: "admin_org_unit",
      objectId: params.data.id,
    });
    return { status: "deleted" };
  });

  // ---- Groups -------------------------------------------------------------

  app.get("/api/admin/groups", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { groups: await store.listGroups(actor.orgId) };
  });

  app.post("/api/admin/groups", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createGroupBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid group.", body.error.issues));
    }
    let group: GroupRecord;
    try {
      group = await store.createGroup({
        orgId: actor.orgId,
        name: body.data.name,
        email: body.data.email,
        kind: body.data.kind,
        description: body.data.description,
        orgUnitId: body.data.orgUnitId,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof GroupsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.group.created",
      objectType: "admin_group",
      objectId: group.id,
      metadata: { name: group.name, kind: group.kind },
    });
    return reply.code(201).send({ group });
  });

  app.patch("/api/admin/groups/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid group id."));
    }
    const body = updateGroupBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid group update.", body.error.issues));
    }
    let group: GroupRecord | null;
    try {
      group = await store.updateGroup({
        orgId: actor.orgId,
        id: params.data.id,
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
        ...(body.data.email === undefined ? {} : { email: body.data.email }),
        ...(body.data.kind === undefined ? {} : { kind: body.data.kind }),
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
        ...(body.data.orgUnitId === undefined ? {} : { orgUnitId: body.data.orgUnitId }),
      });
    } catch (error) {
      if (error instanceof GroupsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    if (group === null) {
      return reply.code(404).send(notFound("Group not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.group.updated",
      objectType: "admin_group",
      objectId: group.id,
      metadata: { fields: Object.keys(body.data) },
    });
    return { group };
  });

  app.delete("/api/admin/groups/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid group id."));
    }
    const deleted = await store.deleteGroup(actor.orgId, params.data.id);
    if (!deleted) {
      return reply.code(404).send(notFound("Group not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.group.deleted",
      objectType: "admin_group",
      objectId: params.data.id,
    });
    return { status: "deleted" };
  });

  // ---- Membership ---------------------------------------------------------

  app.get("/api/admin/groups/:id/members", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid group id."));
    }
    const group = await store.getGroup(actor.orgId, params.data.id);
    if (group === null) {
      return reply.code(404).send(notFound("Group not found."));
    }
    return { members: await store.listGroupMembers(actor.orgId, params.data.id) };
  });

  app.post("/api/admin/groups/:id/members", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid group id."));
    }
    const body = addMemberBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid group member.", body.error.issues));
    }
    const group = await store.getGroup(actor.orgId, params.data.id);
    if (group === null) {
      return reply.code(404).send(notFound("Group not found."));
    }
    let member: GroupMemberRecord;
    try {
      member = await store.addGroupMember({
        orgId: actor.orgId,
        groupId: params.data.id,
        actorId: body.data.actorId,
        role: body.data.role,
        addedBy: actor.id,
      });
    } catch (error) {
      if (error instanceof GroupsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.group.member_added",
      objectType: "admin_group",
      objectId: params.data.id,
      metadata: { memberActorId: member.actorId, role: member.role },
    });
    return reply.code(201).send({ member });
  });

  app.delete("/api/admin/groups/:id/members/:actorId", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = groupMemberParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid group member identifiers."));
    }
    const removed = await store.removeGroupMember(actor.orgId, params.data.id, params.data.actorId);
    if (!removed) {
      return reply.code(404).send(notFound("Group member not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.group.member_removed",
      objectType: "admin_group",
      objectId: params.data.id,
      metadata: { memberActorId: params.data.actorId },
    });
    return { status: "removed" };
  });
}

// --------------------------------------------------------------------------
// Postgres store
// --------------------------------------------------------------------------

interface OrgUnitRow {
  readonly id: string;
  readonly org_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly member_count: string | number;
  readonly child_count: string | number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface GroupRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly kind: GroupKind;
  readonly description: string;
  readonly org_unit_id: string | null;
  readonly member_count: string | number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface GroupMemberRow {
  readonly id: string;
  readonly org_id: string;
  readonly group_id: string;
  readonly actor_id: string;
  readonly role: GroupMemberRole;
  readonly created_at: Date;
}

export class PostgresGroupsStore implements GroupsStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listOrgUnits(orgId: string): Promise<readonly OrgUnitRecord[]> {
    const rows = (await this.sql`
      select
        u.id, u.org_id, u.parent_id, u.name, u.path, u.description,
        coalesce(m.member_count, 0) as member_count,
        coalesce(c.child_count, 0) as child_count,
        u.created_at, u.updated_at
      from admin_org_units u
      left join (
        select g.org_unit_id, count(gm.id) as member_count
        from admin_groups g
        join admin_group_members gm on gm.group_id = g.id
        where g.org_id = ${orgId}
        group by g.org_unit_id
      ) m on m.org_unit_id = u.id
      left join (
        select parent_id, count(*) as child_count
        from admin_org_units
        where org_id = ${orgId} and parent_id is not null
        group by parent_id
      ) c on c.parent_id = u.id
      where u.org_id = ${orgId}
      order by u.path asc, u.created_at asc
    `) as unknown as readonly OrgUnitRow[];
    return rows.map(mapOrgUnitRow);
  }

  async getOrgUnit(orgId: string, id: string): Promise<OrgUnitRecord | null> {
    const rows = (await this.sql`
      select
        u.id, u.org_id, u.parent_id, u.name, u.path, u.description,
        0 as member_count,
        (select count(*) from admin_org_units c where c.parent_id = u.id) as child_count,
        u.created_at, u.updated_at
      from admin_org_units u
      where u.org_id = ${orgId} and u.id = ${id}
    `) as unknown as readonly OrgUnitRow[];
    const row = rows[0];
    return row === undefined ? null : mapOrgUnitRow(row);
  }

  async createOrgUnit(input: CreateOrgUnitInput): Promise<OrgUnitRecord> {
    const path = await this.#computePath(input.orgId, input.parentId, input.name);
    const rows = (await this.sql`
      insert into admin_org_units (org_id, parent_id, name, path, description, created_by)
      values (${input.orgId}, ${input.parentId}, ${input.name}, ${path},
              ${input.description}, ${input.createdBy})
      on conflict do nothing
      returning id, org_id, parent_id, name, path, description,
                0 as member_count, 0 as child_count, created_at, updated_at
    `) as unknown as readonly OrgUnitRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new GroupsConflictError("An org unit with this name already exists at this level.");
    }
    return mapOrgUnitRow(row);
  }

  async updateOrgUnit(input: UpdateOrgUnitInput): Promise<OrgUnitRecord | null> {
    const existing = await this.getOrgUnit(input.orgId, input.id);
    if (existing === null) {
      return null;
    }
    const nextParentId = input.parentId === undefined ? existing.parentId : input.parentId;
    if (nextParentId === input.id) {
      throw new GroupsConflictError("An org unit cannot be its own parent.");
    }
    const nextName = input.name ?? existing.name;
    const nextDescription = input.description ?? existing.description;
    const path = await this.#computePath(input.orgId, nextParentId, nextName);
    const rows = (await this.sql`
      update admin_org_units
      set name = ${nextName}, description = ${nextDescription},
          parent_id = ${nextParentId}, path = ${path}, updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
      returning id, org_id, parent_id, name, path, description,
                0 as member_count, 0 as child_count, created_at, updated_at
    `) as unknown as readonly OrgUnitRow[];
    const row = rows[0];
    return row === undefined ? null : mapOrgUnitRow(row);
  }

  async deleteOrgUnit(
    orgId: string,
    id: string,
  ): Promise<"deleted" | "not_found" | "has_children"> {
    const children = (await this.sql`
      select 1 from admin_org_units where org_id = ${orgId} and parent_id = ${id} limit 1
    `) as unknown as readonly unknown[];
    if (children.length > 0) {
      return "has_children";
    }
    const rows = (await this.sql`
      delete from admin_org_units where org_id = ${orgId} and id = ${id} returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0 ? "deleted" : "not_found";
  }

  async listGroups(orgId: string): Promise<readonly GroupRecord[]> {
    const rows = (await this.sql`
      select
        g.id, g.org_id, g.name, g.email, g.kind, g.description, g.org_unit_id,
        coalesce(count(gm.id), 0) as member_count,
        g.created_at, g.updated_at
      from admin_groups g
      left join admin_group_members gm on gm.group_id = g.id
      where g.org_id = ${orgId}
      group by g.id
      order by g.created_at desc, g.id desc
    `) as unknown as readonly GroupRow[];
    return rows.map(mapGroupRow);
  }

  async getGroup(orgId: string, id: string): Promise<GroupRecord | null> {
    const rows = (await this.sql`
      select
        g.id, g.org_id, g.name, g.email, g.kind, g.description, g.org_unit_id,
        coalesce(count(gm.id), 0) as member_count,
        g.created_at, g.updated_at
      from admin_groups g
      left join admin_group_members gm on gm.group_id = g.id
      where g.org_id = ${orgId} and g.id = ${id}
      group by g.id
    `) as unknown as readonly GroupRow[];
    const row = rows[0];
    return row === undefined ? null : mapGroupRow(row);
  }

  async createGroup(input: CreateGroupInput): Promise<GroupRecord> {
    const rows = (await this.sql`
      insert into admin_groups (org_id, name, email, kind, description, org_unit_id, created_by)
      values (${input.orgId}, ${input.name}, ${input.email}, ${input.kind},
              ${input.description}, ${input.orgUnitId}, ${input.createdBy})
      on conflict do nothing
      returning id, org_id, name, email, kind, description, org_unit_id,
                0 as member_count, created_at, updated_at
    `) as unknown as readonly GroupRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new GroupsConflictError("A group with this name already exists.");
    }
    return mapGroupRow(row);
  }

  async updateGroup(input: UpdateGroupInput): Promise<GroupRecord | null> {
    const existing = await this.getGroup(input.orgId, input.id);
    if (existing === null) {
      return null;
    }
    const rows = (await this.sql`
      update admin_groups
      set name = ${input.name ?? existing.name},
          email = ${input.email === undefined ? existing.email : input.email},
          kind = ${input.kind ?? existing.kind},
          description = ${input.description ?? existing.description},
          org_unit_id = ${input.orgUnitId === undefined ? existing.orgUnitId : input.orgUnitId},
          updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
      returning id, org_id, name, email, kind, description, org_unit_id,
                0 as member_count, created_at, updated_at
    `) as unknown as readonly GroupRow[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return { ...mapGroupRow(row), memberCount: existing.memberCount };
  }

  async deleteGroup(orgId: string, id: string): Promise<boolean> {
    const rows = (await this.sql`
      delete from admin_groups where org_id = ${orgId} and id = ${id} returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0;
  }

  async listGroupMembers(orgId: string, groupId: string): Promise<readonly GroupMemberRecord[]> {
    const rows = (await this.sql`
      select id, org_id, group_id, actor_id, role, created_at
      from admin_group_members
      where org_id = ${orgId} and group_id = ${groupId}
      order by created_at asc, id asc
    `) as unknown as readonly GroupMemberRow[];
    return rows.map(mapGroupMemberRow);
  }

  async addGroupMember(input: AddGroupMemberInput): Promise<GroupMemberRecord> {
    const rows = (await this.sql`
      insert into admin_group_members (org_id, group_id, actor_id, role, added_by)
      values (${input.orgId}, ${input.groupId}, ${input.actorId}, ${input.role}, ${input.addedBy})
      on conflict (group_id, actor_id) do nothing
      returning id, org_id, group_id, actor_id, role, created_at
    `) as unknown as readonly GroupMemberRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new GroupsConflictError("This actor is already a member of the group.");
    }
    return mapGroupMemberRow(row);
  }

  async removeGroupMember(orgId: string, groupId: string, actorId: string): Promise<boolean> {
    const rows = (await this.sql`
      delete from admin_group_members
      where org_id = ${orgId} and group_id = ${groupId} and actor_id = ${actorId}
      returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0;
  }

  async #computePath(
    orgId: string,
    parentId: string | null,
    name: string,
  ): Promise<string> {
    if (parentId === null) {
      return name;
    }
    const rows = (await this.sql`
      select path from admin_org_units where org_id = ${orgId} and id = ${parentId}
    `) as unknown as readonly { readonly path: string }[];
    const parentPath = rows[0]?.path;
    if (parentPath === undefined) {
      throw new GroupsConflictError("Parent org unit not found.");
    }
    return `${parentPath} > ${name}`;
  }
}

function mapOrgUnitRow(row: OrgUnitRow): OrgUnitRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    parentId: row.parent_id,
    name: row.name,
    path: row.path,
    description: row.description,
    memberCount: Number(row.member_count),
    childCount: Number(row.child_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapGroupRow(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    email: row.email,
    kind: row.kind,
    description: row.description,
    orgUnitId: row.org_unit_id,
    memberCount: Number(row.member_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapGroupMemberRow(row: GroupMemberRow): GroupMemberRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    groupId: row.group_id,
    actorId: row.actor_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

// --------------------------------------------------------------------------
// In-memory store (tests / offline)
// --------------------------------------------------------------------------

interface MemOrgUnit {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface MemGroup {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  kind: GroupKind;
  description: string;
  orgUnitId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Deterministic in-memory {@link GroupsStore}. IDs are supplied so tests stay
 * stable; `now` defaults to a fixed clock.
 */
export class InMemoryGroupsStore implements GroupsStore {
  readonly #orgUnits = new Map<string, MemOrgUnit>();
  readonly #groups = new Map<string, MemGroup>();
  readonly #members: GroupMemberRecord[] = [];
  #seq = 0;

  constructor(
    private readonly options: {
      readonly now?: () => Date;
      readonly nextId?: () => string;
    } = {},
  ) {}

  #now(): string {
    return (this.options.now ?? (() => new Date("2026-05-21T00:00:00.000Z")))().toISOString();
  }

  #id(): string {
    if (this.options.nextId !== undefined) {
      return this.options.nextId();
    }
    this.#seq += 1;
    return `00000000-0000-4000-8000-${this.#seq.toString(16).padStart(12, "0")}`;
  }

  #path(orgId: string, parentId: string | null, name: string): string {
    if (parentId === null) {
      return name;
    }
    const parent = this.#orgUnits.get(parentId);
    if (parent === undefined || parent.orgId !== orgId) {
      throw new GroupsConflictError("Parent org unit not found.");
    }
    return `${this.#path(orgId, parent.parentId, parent.name)} > ${name}`;
  }

  #renderOrgUnit(unit: MemOrgUnit): OrgUnitRecord {
    const childCount = [...this.#orgUnits.values()].filter(
      (candidate) => candidate.orgId === unit.orgId && candidate.parentId === unit.id,
    ).length;
    const memberCount = [...this.#groups.values()]
      .filter((group) => group.orgId === unit.orgId && group.orgUnitId === unit.id)
      .reduce(
        (total, group) =>
          total + this.#members.filter((member) => member.groupId === group.id).length,
        0,
      );
    return {
      id: unit.id,
      orgId: unit.orgId,
      parentId: unit.parentId,
      name: unit.name,
      path: this.#path(unit.orgId, unit.parentId, unit.name),
      description: unit.description,
      memberCount,
      childCount,
      createdAt: unit.createdAt,
      updatedAt: unit.updatedAt,
    };
  }

  #renderGroup(group: MemGroup): GroupRecord {
    return {
      id: group.id,
      orgId: group.orgId,
      name: group.name,
      email: group.email,
      kind: group.kind,
      description: group.description,
      orgUnitId: group.orgUnitId,
      memberCount: this.#members.filter((member) => member.groupId === group.id).length,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  async listOrgUnits(orgId: string): Promise<readonly OrgUnitRecord[]> {
    return [...this.#orgUnits.values()]
      .filter((unit) => unit.orgId === orgId)
      .map((unit) => this.#renderOrgUnit(unit))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async getOrgUnit(orgId: string, id: string): Promise<OrgUnitRecord | null> {
    const unit = this.#orgUnits.get(id);
    return unit === undefined || unit.orgId !== orgId ? null : this.#renderOrgUnit(unit);
  }

  async createOrgUnit(input: CreateOrgUnitInput): Promise<OrgUnitRecord> {
    const clash = [...this.#orgUnits.values()].some(
      (unit) =>
        unit.orgId === input.orgId &&
        unit.parentId === input.parentId &&
        unit.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (clash) {
      throw new GroupsConflictError("An org unit with this name already exists at this level.");
    }
    if (input.parentId !== null) {
      const parent = this.#orgUnits.get(input.parentId);
      if (parent === undefined || parent.orgId !== input.orgId) {
        throw new GroupsConflictError("Parent org unit not found.");
      }
    }
    const now = this.#now();
    const unit: MemOrgUnit = {
      id: this.#id(),
      orgId: input.orgId,
      parentId: input.parentId,
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
    this.#orgUnits.set(unit.id, unit);
    return this.#renderOrgUnit(unit);
  }

  async updateOrgUnit(input: UpdateOrgUnitInput): Promise<OrgUnitRecord | null> {
    const unit = this.#orgUnits.get(input.id);
    if (unit === undefined || unit.orgId !== input.orgId) {
      return null;
    }
    if (input.parentId !== undefined && input.parentId === input.id) {
      throw new GroupsConflictError("An org unit cannot be its own parent.");
    }
    if (input.name !== undefined) {
      unit.name = input.name;
    }
    if (input.description !== undefined) {
      unit.description = input.description;
    }
    if (input.parentId !== undefined) {
      unit.parentId = input.parentId;
    }
    unit.updatedAt = this.#now();
    return this.#renderOrgUnit(unit);
  }

  async deleteOrgUnit(
    orgId: string,
    id: string,
  ): Promise<"deleted" | "not_found" | "has_children"> {
    const unit = this.#orgUnits.get(id);
    if (unit === undefined || unit.orgId !== orgId) {
      return "not_found";
    }
    const hasChildren = [...this.#orgUnits.values()].some(
      (candidate) => candidate.orgId === orgId && candidate.parentId === id,
    );
    if (hasChildren) {
      return "has_children";
    }
    this.#orgUnits.delete(id);
    for (const group of this.#groups.values()) {
      if (group.orgUnitId === id) {
        group.orgUnitId = null;
      }
    }
    return "deleted";
  }

  async listGroups(orgId: string): Promise<readonly GroupRecord[]> {
    return [...this.#groups.values()]
      .filter((group) => group.orgId === orgId)
      .map((group) => this.#renderGroup(group))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getGroup(orgId: string, id: string): Promise<GroupRecord | null> {
    const group = this.#groups.get(id);
    return group === undefined || group.orgId !== orgId ? null : this.#renderGroup(group);
  }

  async createGroup(input: CreateGroupInput): Promise<GroupRecord> {
    const clash = [...this.#groups.values()].some(
      (group) =>
        group.orgId === input.orgId && group.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (clash) {
      throw new GroupsConflictError("A group with this name already exists.");
    }
    const now = this.#now();
    const group: MemGroup = {
      id: this.#id(),
      orgId: input.orgId,
      name: input.name,
      email: input.email,
      kind: input.kind,
      description: input.description,
      orgUnitId: input.orgUnitId,
      createdAt: now,
      updatedAt: now,
    };
    this.#groups.set(group.id, group);
    return this.#renderGroup(group);
  }

  async updateGroup(input: UpdateGroupInput): Promise<GroupRecord | null> {
    const group = this.#groups.get(input.id);
    if (group === undefined || group.orgId !== input.orgId) {
      return null;
    }
    if (input.name !== undefined) {
      group.name = input.name;
    }
    if (input.email !== undefined) {
      group.email = input.email;
    }
    if (input.kind !== undefined) {
      group.kind = input.kind;
    }
    if (input.description !== undefined) {
      group.description = input.description;
    }
    if (input.orgUnitId !== undefined) {
      group.orgUnitId = input.orgUnitId;
    }
    group.updatedAt = this.#now();
    return this.#renderGroup(group);
  }

  async deleteGroup(orgId: string, id: string): Promise<boolean> {
    const group = this.#groups.get(id);
    if (group === undefined || group.orgId !== orgId) {
      return false;
    }
    this.#groups.delete(id);
    for (let index = this.#members.length - 1; index >= 0; index -= 1) {
      if (this.#members[index]?.groupId === id) {
        this.#members.splice(index, 1);
      }
    }
    return true;
  }

  async listGroupMembers(orgId: string, groupId: string): Promise<readonly GroupMemberRecord[]> {
    return this.#members
      .filter((member) => member.orgId === orgId && member.groupId === groupId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async addGroupMember(input: AddGroupMemberInput): Promise<GroupMemberRecord> {
    const exists = this.#members.some(
      (member) => member.groupId === input.groupId && member.actorId === input.actorId,
    );
    if (exists) {
      throw new GroupsConflictError("This actor is already a member of the group.");
    }
    const member: GroupMemberRecord = {
      id: this.#id(),
      orgId: input.orgId,
      groupId: input.groupId,
      actorId: input.actorId,
      role: input.role,
      createdAt: this.#now(),
    };
    this.#members.push(member);
    return member;
  }

  async removeGroupMember(orgId: string, groupId: string, actorId: string): Promise<boolean> {
    const index = this.#members.findIndex(
      (member) =>
        member.orgId === orgId && member.groupId === groupId && member.actorId === actorId,
    );
    if (index === -1) {
      return false;
    }
    this.#members.splice(index, 1);
    return true;
  }
}
