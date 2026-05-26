import type postgres from "postgres";
import type { Actor, JsonObject, JsonValue } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { GroupsConflictError, type GroupRecord, type GroupsStore } from "../admin/groups.js";
import type { OrgStore } from "../tenancy/orgs.js";

export interface RegisterTenantScimRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly documentationUri?: string | undefined;
  readonly users?: ScimUserStore | undefined;
  readonly groups?: GroupsStore | undefined;
  readonly actorFromRequest?: ((request: FastifyRequest) => Promise<Actor> | Actor) | undefined;
}

export interface ScimUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly userName: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly externalId: string | null;
  readonly email: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListScimUsersInput {
  readonly orgId: string;
  readonly startIndex: number;
  readonly count: number;
  readonly filterUserName?: string | undefined;
}

export interface CreateScimUserInput {
  readonly orgId: string;
  readonly userName: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly externalId?: string | undefined;
  readonly email?: string | undefined;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
}

export interface UpdateScimUserInput {
  readonly orgId: string;
  readonly id: string;
  readonly userName?: string | undefined;
  readonly active?: boolean | undefined;
  readonly displayName?: string | undefined;
  readonly externalId?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly givenName?: string | null | undefined;
  readonly familyName?: string | null | undefined;
}

export interface ScimUserListResult {
  readonly totalResults: number;
  readonly users: readonly ScimUserRecord[];
}

export interface ScimUserStore {
  listUsers(input: ListScimUsersInput): Promise<ScimUserListResult>;
  getUser(input: { readonly orgId: string; readonly id: string }): Promise<ScimUserRecord | null>;
  createUser(input: CreateScimUserInput): Promise<ScimUserRecord>;
  updateUser(input: UpdateScimUserInput): Promise<ScimUserRecord | null>;
  deleteUser(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<ScimUserRecord | null>;
}

export class ScimUserConflictError extends Error {
  constructor(readonly userName: string) {
    super(`SCIM user already exists: ${userName}`);
    this.name = "ScimUserConflictError";
  }
}

const scimTenantParams = z.object({
  tenantSlug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
});
const scimUserParams = scimTenantParams.extend({
  userId: z.string().trim().min(1).max(100),
});
const scimGroupParams = scimTenantParams.extend({
  groupId: z.string().uuid(),
});
const scimUsersQuery = z.object({
  count: z.coerce.number().int().min(1).max(200).default(100),
  filter: z.string().trim().min(1).max(500).optional(),
  startIndex: z.coerce.number().int().min(1).default(1),
});
const scimGroupsQuery = scimUsersQuery;
const scimCreateUserBody = z.object({
  active: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  emails: z
    .array(
      z.object({
        primary: z.boolean().optional(),
        value: z.string().trim().email().max(320),
      }),
    )
    .max(10)
    .optional(),
  externalId: z.string().trim().min(1).max(255).optional(),
  name: z
    .object({
      familyName: z.string().trim().max(120).optional(),
      formatted: z.string().trim().max(240).optional(),
      givenName: z.string().trim().max(120).optional(),
    })
    .optional(),
  userName: z.string().trim().email().max(320),
});
const scimPutUserBody = scimCreateUserBody;
const scimPatchUserBody = z.object({
  Operations: z
    .array(
      z.object({
        op: z
          .string()
          .trim()
          .transform((value) => value.toLowerCase()),
        path: z.string().trim().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(20),
  schemas: z.array(z.string()).optional(),
});
const scimGroupMemberBody = z.object({
  display: z.string().trim().max(240).optional(),
  value: z.string().uuid(),
});
const scimCreateGroupBody = z.object({
  displayName: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(255).optional(),
  members: z.array(scimGroupMemberBody).max(1000).optional(),
});
const scimPutGroupBody = scimCreateGroupBody;
const scimPatchGroupBody = z.object({
  Operations: z
    .array(
      z.object({
        op: z
          .string()
          .trim()
          .transform((value) => value.toLowerCase()),
        path: z.string().trim().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(50),
  schemas: z.array(z.string()).optional(),
});

const SCIM_JSON = "application/scim+json; charset=utf-8";
const LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const unsupportedScimUserNameFilter = Symbol("unsupported-scim-user-name-filter");
const unsupportedScimGroupFilter = Symbol("unsupported-scim-group-filter");

export async function registerTenantScimRoutes(
  app: FastifyInstance,
  options: RegisterTenantScimRoutesOptions,
): Promise<void> {
  app.get("/api/scim/v2/:tenantSlug/ServiceProviderConfig", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(serviceProviderConfig(options.documentationUri));
  });

  app.get("/api/scim/v2/:tenantSlug/ResourceTypes", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimListResponse(resourceTypes(tenant.slug)));
  });

  app.get("/api/scim/v2/:tenantSlug/Schemas", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimListResponse(scimSchemas()));
  });

  app.get("/api/scim/v2/:tenantSlug/Users", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const auth = await authenticateScimUsersRequest(request, tenant, options, "scim.users.read");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const query = scimUsersQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Users query."));
    }
    const filterUserName = scimUserNameFilter(query.data.filter);
    if (filterUserName === unsupportedScimUserNameFilter) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Unsupported SCIM Users filter."));
    }
    const users = await auth.users.listUsers({
      orgId: tenant.id,
      count: query.data.count,
      startIndex: query.data.startIndex,
      ...(filterUserName === undefined ? {} : { filterUserName }),
    });
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(
        scimListResponse(
          users.users.map((user) => scimUserResource(user, tenant.slug)),
          {
            startIndex: query.data.startIndex,
            totalResults: users.totalResults,
          },
        ),
      );
  });

  app.post("/api/scim/v2/:tenantSlug/Users", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const auth = await authenticateScimUsersRequest(request, tenant, options, "scim.users.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const body = scimCreateUserBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User create request."));
    }
    try {
      const primaryEmail = scimPrimaryEmail(body.data);
      const user = await auth.users.createUser({
        orgId: tenant.id,
        userName: normalizeUserName(body.data.userName),
        displayName: scimDisplayName(body.data),
        active: body.data.active ?? true,
        ...(body.data.externalId === undefined ? {} : { externalId: body.data.externalId }),
        ...(primaryEmail === undefined ? {} : { email: primaryEmail }),
        ...(body.data.name?.givenName === undefined ? {} : { givenName: body.data.name.givenName }),
        ...(body.data.name?.familyName === undefined
          ? {}
          : { familyName: body.data.name.familyName }),
      });
      const resource = scimUserResource(user, tenant.slug);
      return await reply
        .code(201)
        .header("content-type", SCIM_JSON)
        .header("location", resource.meta.location)
        .send(resource);
    } catch (error) {
      if (error instanceof ScimUserConflictError) {
        return reply
          .code(409)
          .header("content-type", SCIM_JSON)
          .send(scimError(409, "SCIM user already exists."));
      }
      throw error;
    }
  });

  app.get("/api/scim/v2/:tenantSlug/Users/:userId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimUserParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User id."));
    }
    const auth = await authenticateScimUsersRequest(request, tenant, options, "scim.users.read");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const user = await auth.users.getUser({ orgId: tenant.id, id: params.data.userId });
    if (user === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM user was not found."));
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimUserResource(user, tenant.slug));
  });

  app.patch("/api/scim/v2/:tenantSlug/Users/:userId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimUserParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User id."));
    }
    const auth = await authenticateScimUsersRequest(request, tenant, options, "scim.users.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const body = scimPatchUserBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User patch request."));
    }
    const patch = scimPatchUserInput(body.data.Operations);
    if (patch === "unsupported") {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Unsupported SCIM User patch operation."));
    }
    const user = await auth.users.updateUser({
      orgId: tenant.id,
      id: params.data.userId,
      ...patch,
    });
    if (user === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM user was not found."));
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .send(scimUserResource(user, tenant.slug));
  });

  app.put("/api/scim/v2/:tenantSlug/Users/:userId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimUserParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User id."));
    }
    const auth = await authenticateScimUsersRequest(request, tenant, options, "scim.users.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const body = scimPutUserBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User replace request."));
    }
    const primaryEmail = scimPrimaryEmail(body.data);
    const user = await auth.users.updateUser({
      orgId: tenant.id,
      id: params.data.userId,
      userName: normalizeUserName(body.data.userName),
      displayName: scimDisplayName(body.data),
      active: body.data.active ?? true,
      externalId: body.data.externalId ?? null,
      email: primaryEmail ?? normalizeUserName(body.data.userName),
      givenName: body.data.name?.givenName ?? null,
      familyName: body.data.name?.familyName ?? null,
    });
    if (user === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM user was not found."));
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .send(scimUserResource(user, tenant.slug));
  });

  app.delete("/api/scim/v2/:tenantSlug/Users/:userId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimUserParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM User id."));
    }
    const auth = await authenticateScimUsersRequest(request, tenant, options, "scim.users.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const user = await auth.users.deleteUser({ orgId: tenant.id, id: params.data.userId });
    if (user === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM user was not found."));
    }
    return reply.code(204).send();
  });

  app.route({
    method: ["PUT", "PATCH", "DELETE"],
    url: "/api/scim/v2/:tenantSlug/Users",
    handler: async (request, reply) => {
      const tenant = await resolveActiveScimTenant(request.params, options);
      if (!tenant.success) {
        return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
      }
      return reply
        .code(501)
        .header("content-type", SCIM_JSON)
        .send(scimError(501, "Users SCIM provisioning is not implemented yet."));
    },
  });

  app.get("/api/scim/v2/:tenantSlug/Groups", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const auth = await authenticateScimGroupsRequest(request, tenant, options, "scim.groups.read");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const query = scimGroupsQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Groups query."));
    }
    const filterDisplayName = scimGroupDisplayNameFilter(query.data.filter);
    if (filterDisplayName === unsupportedScimGroupFilter) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Unsupported SCIM Groups filter."));
    }
    const allGroups = await auth.groups.listGroups(tenant.id);
    const filteredGroups =
      filterDisplayName === undefined
        ? allGroups
        : allGroups.filter((group) => group.name.toLowerCase() === filterDisplayName);
    const page = filteredGroups.slice(
      query.data.startIndex - 1,
      query.data.startIndex - 1 + query.data.count,
    );
    const resources = await Promise.all(
      page.map((group) => scimGroupResource(auth.groups, tenant.slug, group)),
    );
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(
        scimListResponse(resources, {
          startIndex: query.data.startIndex,
          totalResults: filteredGroups.length,
        }),
      );
  });

  app.post("/api/scim/v2/:tenantSlug/Groups", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const auth = await authenticateScimGroupsRequest(request, tenant, options, "scim.groups.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const body = scimCreateGroupBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group create request."));
    }
    try {
      const group = await auth.groups.createGroup({
        orgId: tenant.id,
        name: body.data.displayName,
        externalId: body.data.externalId ?? null,
        email: null,
        kind: "group",
        description: "",
        orgUnitId: null,
        createdBy: auth.actor.id,
      });
      await reconcileScimGroupMembers(auth.groups, {
        orgId: tenant.id,
        groupId: group.id,
        actorId: auth.actor.id,
        members: scimGroupMemberValues(body.data.members),
      });
      const resource = await scimGroupResource(auth.groups, tenant.slug, group);
      return await reply
        .code(201)
        .header("content-type", SCIM_JSON)
        .header("location", resource.meta.location)
        .send(resource);
    } catch (error) {
      if (error instanceof GroupsConflictError) {
        return reply
          .code(409)
          .header("content-type", SCIM_JSON)
          .send(scimError(409, "SCIM group already exists."));
      }
      throw error;
    }
  });

  app.get("/api/scim/v2/:tenantSlug/Groups/:groupId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimGroupParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group id."));
    }
    const auth = await authenticateScimGroupsRequest(request, tenant, options, "scim.groups.read");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const group = await auth.groups.getGroup(tenant.id, params.data.groupId);
    if (group === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM group was not found."));
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(await scimGroupResource(auth.groups, tenant.slug, group));
  });

  app.put("/api/scim/v2/:tenantSlug/Groups/:groupId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimGroupParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group id."));
    }
    const auth = await authenticateScimGroupsRequest(request, tenant, options, "scim.groups.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const body = scimPutGroupBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group replace request."));
    }
    const group = await auth.groups.updateGroup({
      orgId: tenant.id,
      id: params.data.groupId,
      name: body.data.displayName,
      externalId: body.data.externalId ?? null,
    });
    if (group === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM group was not found."));
    }
    await reconcileScimGroupMembers(auth.groups, {
      orgId: tenant.id,
      groupId: group.id,
      actorId: auth.actor.id,
      members: scimGroupMemberValues(body.data.members),
    });
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .send(await scimGroupResource(auth.groups, tenant.slug, group));
  });

  app.patch("/api/scim/v2/:tenantSlug/Groups/:groupId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimGroupParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group id."));
    }
    const auth = await authenticateScimGroupsRequest(request, tenant, options, "scim.groups.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const body = scimPatchGroupBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group patch request."));
    }
    const patch = scimPatchGroupInput(body.data.Operations);
    if (patch === "unsupported") {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Unsupported SCIM Group patch operation."));
    }
    const existing = await auth.groups.getGroup(tenant.id, params.data.groupId);
    if (existing === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM group was not found."));
    }
    const group =
      patch.name === undefined && patch.externalId === undefined
        ? existing
        : await auth.groups.updateGroup({
            orgId: tenant.id,
            id: params.data.groupId,
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.externalId === undefined ? {} : { externalId: patch.externalId }),
          });
    if (group === null) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM group was not found."));
    }
    await applyScimGroupMemberPatch(auth.groups, {
      orgId: tenant.id,
      groupId: group.id,
      actorId: auth.actor.id,
      addMembers: patch.addMembers,
      removeMembers: patch.removeMembers,
      replaceMembers: patch.replaceMembers,
    });
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .send(await scimGroupResource(auth.groups, tenant.slug, group));
  });

  app.delete("/api/scim/v2/:tenantSlug/Groups/:groupId", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    const params = scimGroupParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .header("content-type", SCIM_JSON)
        .send(scimError(400, "Invalid SCIM Group id."));
    }
    const auth = await authenticateScimGroupsRequest(request, tenant, options, "scim.groups.write");
    if (!auth.success) {
      return reply.code(auth.status).header("content-type", SCIM_JSON).send(auth.body);
    }
    const deleted = await auth.groups.deleteGroup(tenant.id, params.data.groupId);
    if (!deleted) {
      return reply
        .code(404)
        .header("content-type", SCIM_JSON)
        .send(scimError(404, "SCIM group was not found."));
    }
    return reply.code(204).send();
  });
}

export class PostgresScimUserStore implements ScimUserStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listUsers(input: ListScimUsersInput): Promise<ScimUserListResult> {
    const filterUserName = input.filterUserName?.trim().toLowerCase() ?? null;
    const offset = input.startIndex - 1;
    const totalRows = (await this.sql`
      select count(*)::integer as row_count
      from actors
      where org_id = ${input.orgId}
        and type = 'user'
        and (
          ${filterUserName}::text is null
          or lower(email) = ${filterUserName}
          or lower(metadata -> 'scim' ->> 'userName') = ${filterUserName}
        )
    `) as unknown as readonly { readonly row_count: number }[];
    const rows = (await this.sql`
      select id, org_id, email, display_name, disabled_at, metadata, created_at, updated_at
      from actors
      where org_id = ${input.orgId}
        and type = 'user'
        and (
          ${filterUserName}::text is null
          or lower(email) = ${filterUserName}
          or lower(metadata -> 'scim' ->> 'userName') = ${filterUserName}
        )
      order by created_at asc, id asc
      limit ${input.count}
      offset ${offset}
    `) as unknown as readonly ScimUserRow[];
    return {
      totalResults: totalRows[0]?.row_count ?? 0,
      users: rows.map(mapScimUserRow),
    };
  }

  async getUser(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<ScimUserRecord | null> {
    const rows = (await this.sql`
      select id, org_id, email, display_name, disabled_at, metadata, created_at, updated_at
      from actors
      where org_id = ${input.orgId}
        and id = ${input.id}
        and type = 'user'
      limit 1
    `) as unknown as readonly ScimUserRow[];
    return rowOrNull(rows[0]);
  }

  async createUser(input: CreateScimUserInput): Promise<ScimUserRecord> {
    const userName = normalizeUserName(input.userName);
    const email = input.email ?? userName;
    const metadata = scimActorMetadata({
      userName,
      externalId: input.externalId,
      givenName: input.givenName,
      familyName: input.familyName,
    });
    const rows = (await this.sql`
      insert into actors (
        org_id,
        type,
        email,
        display_name,
        disabled_at,
        metadata
      )
      select
        ${input.orgId},
        ${"user"},
        ${email},
        ${input.displayName},
        ${input.active ? null : new Date()},
        ${this.sql.json(metadata)}
      where not exists (
        select 1
        from actors
        where org_id = ${input.orgId}
          and type = 'user'
          and (
            lower(email) = ${userName}
            or lower(metadata -> 'scim' ->> 'userName') = ${userName}
          )
      )
      returning id, org_id, email, display_name, disabled_at, metadata, created_at, updated_at
    `) as unknown as readonly ScimUserRow[];
    const user = rowOrNull(rows[0]);
    if (user === null) {
      throw new ScimUserConflictError(userName);
    }
    return user;
  }

  async updateUser(input: UpdateScimUserInput): Promise<ScimUserRecord | null> {
    const existing = await this.getUser({ orgId: input.orgId, id: input.id });
    if (existing === null) {
      return null;
    }
    const userName = input.userName ?? existing.userName;
    const active = input.active ?? existing.active;
    const email = input.email === null ? null : (input.email ?? existing.email);
    const displayName = input.displayName ?? existing.displayName;
    const metadata = scimActorMetadata({
      userName,
      externalId:
        input.externalId === null
          ? undefined
          : (input.externalId ?? existing.externalId ?? undefined),
      givenName:
        input.givenName === null ? undefined : (input.givenName ?? existing.givenName ?? undefined),
      familyName:
        input.familyName === null
          ? undefined
          : (input.familyName ?? existing.familyName ?? undefined),
    });
    const rows = (await this.sql`
      update actors
      set email = ${email},
          display_name = ${displayName},
          disabled_at = ${active ? null : new Date()},
          metadata = metadata || ${this.sql.json(metadata)},
          updated_at = now()
      where org_id = ${input.orgId}
        and id = ${input.id}
        and type = 'user'
      returning id, org_id, email, display_name, disabled_at, metadata, created_at, updated_at
    `) as unknown as readonly ScimUserRow[];
    return rowOrNull(rows[0]);
  }

  async deleteUser(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<ScimUserRecord | null> {
    return this.updateUser({ orgId: input.orgId, id: input.id, active: false });
  }
}

function serviceProviderConfig(documentationUri: string | undefined) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    ...(documentationUri === undefined ? {} : { documentationUri }),
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Per-tenant SCIM bearer token for tenant-scoped provisioning clients.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      },
    ],
  };
}

function resourceTypes(tenantSlug: string) {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: `/api/scim/v2/${tenantSlug}/Users`,
      schema: "urn:ietf:params:scim:schemas:core:2.0:User",
      schemaExtensions: [],
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: `/api/scim/v2/${tenantSlug}/Groups`,
      schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
      schemaExtensions: [],
    },
  ];
}

function scimSchemas() {
  return [
    {
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
      name: "User",
      description: "User account representation for tenant-scoped actor provisioning.",
      attributes: [
        {
          name: "userName",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "readWrite",
        },
        {
          name: "active",
          type: "boolean",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "name",
          type: "complex",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "emails",
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
    {
      id: "urn:ietf:params:scim:schemas:core:2.0:Group",
      name: "Group",
      description: "Group representation backed by tenant-scoped admin groups.",
      attributes: [
        {
          name: "displayName",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "readWrite",
        },
        {
          name: "members",
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
  ];
}

function scimListResponse<T>(
  resources: readonly T[],
  options: {
    readonly startIndex?: number | undefined;
    readonly totalResults?: number | undefined;
  } = {},
) {
  return {
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults: options.totalResults ?? resources.length,
    startIndex: options.startIndex ?? 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

async function authenticateScimUsersRequest(
  request: FastifyRequest,
  tenant: { readonly id: string; readonly slug: string },
  options: RegisterTenantScimRoutesOptions,
  requiredScope: "scim.users.read" | "scim.users.write",
): Promise<
  | { readonly success: true; readonly users: ScimUserStore }
  | { readonly success: false; readonly status: number; readonly body: unknown }
> {
  if (options.users === undefined || options.actorFromRequest === undefined) {
    return {
      success: false,
      status: 501,
      body: scimError(501, "Users SCIM provisioning is not configured."),
    };
  }
  const actor = await options.actorFromRequest(request);
  if (actor.id === "anonymous") {
    return {
      success: false,
      status: 401,
      body: scimError(401, "SCIM authentication is required."),
    };
  }
  if (actor.orgId !== tenant.id) {
    return {
      success: false,
      status: 403,
      body: scimError(403, "SCIM tenant permission denied."),
    };
  }
  const scopes = actor.scopes ?? [];
  if (
    !scopes.includes(requiredScope) &&
    !scopes.includes("scim.users.*") &&
    !scopes.includes("scim.*") &&
    !scopes.includes("admin.*")
  ) {
    return {
      success: false,
      status: 403,
      body: scimError(403, "SCIM Users permission denied."),
    };
  }
  return { success: true, users: options.users };
}

async function authenticateScimGroupsRequest(
  request: FastifyRequest,
  tenant: { readonly id: string; readonly slug: string },
  options: RegisterTenantScimRoutesOptions,
  requiredScope: "scim.groups.read" | "scim.groups.write",
): Promise<
  | { readonly success: true; readonly actor: Actor; readonly groups: GroupsStore }
  | { readonly success: false; readonly status: number; readonly body: unknown }
> {
  if (options.groups === undefined || options.actorFromRequest === undefined) {
    return {
      success: false,
      status: 501,
      body: scimError(501, "Groups SCIM provisioning is not configured."),
    };
  }
  const actor = await options.actorFromRequest(request);
  if (actor.id === "anonymous") {
    return {
      success: false,
      status: 401,
      body: scimError(401, "SCIM authentication is required."),
    };
  }
  if (actor.orgId !== tenant.id) {
    return {
      success: false,
      status: 403,
      body: scimError(403, "SCIM tenant permission denied."),
    };
  }
  const scopes = actor.scopes ?? [];
  if (
    !scopes.includes(requiredScope) &&
    !scopes.includes("scim.groups.*") &&
    !scopes.includes("scim.*") &&
    !scopes.includes("admin.*")
  ) {
    return {
      success: false,
      status: 403,
      body: scimError(403, "SCIM Groups permission denied."),
    };
  }
  return { success: true, actor, groups: options.groups };
}

function scimUserNameFilter(
  filter: string | undefined,
): string | typeof unsupportedScimUserNameFilter | undefined {
  if (filter === undefined) {
    return undefined;
  }
  const match = /^userName\s+eq\s+"(?<userName>[^"]+)"$/iu.exec(filter);
  const userName = match?.groups?.["userName"]?.trim();
  return userName === undefined || userName.length === 0
    ? unsupportedScimUserNameFilter
    : normalizeUserName(userName);
}

function scimGroupDisplayNameFilter(
  filter: string | undefined,
): string | typeof unsupportedScimGroupFilter | undefined {
  if (filter === undefined) {
    return undefined;
  }
  const match = /^displayName\s+eq\s+"(?<displayName>[^"]+)"$/iu.exec(filter);
  const displayName = match?.groups?.["displayName"]?.trim();
  return displayName === undefined || displayName.length === 0
    ? unsupportedScimGroupFilter
    : displayName.toLowerCase();
}

function scimPatchUserInput(
  operations: z.output<typeof scimPatchUserBody>["Operations"],
): Omit<UpdateScimUserInput, "id" | "orgId"> | "unsupported" {
  const patch: {
    active?: boolean;
    displayName?: string;
    externalId?: string | null;
    givenName?: string | null;
    familyName?: string | null;
  } = {};
  for (const operation of operations) {
    if (operation.op !== "replace" && operation.op !== "add") {
      return "unsupported";
    }
    if (operation.path === undefined) {
      if (!applyScimPatchObject(patch, operation.value)) {
        return "unsupported";
      }
      continue;
    }
    if (!applyScimPatchPath(patch, operation.path, operation.value)) {
      return "unsupported";
    }
  }
  return patch;
}

function applyScimPatchObject(
  patch: {
    active?: boolean;
    displayName?: string;
    externalId?: string | null;
    givenName?: string | null;
    familyName?: string | null;
  },
  value: unknown,
): boolean {
  const record = readRecord(value);
  if (record === undefined) {
    return false;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (!applyScimPatchPath(patch, key, entry)) {
      return false;
    }
  }
  return true;
}

function applyScimPatchPath(
  patch: {
    active?: boolean;
    displayName?: string;
    externalId?: string | null;
    givenName?: string | null;
    familyName?: string | null;
  },
  path: string,
  value: unknown,
): boolean {
  const normalizedPath = path.trim().toLowerCase();
  if (normalizedPath === "active" && typeof value === "boolean") {
    patch.active = value;
    return true;
  }
  if (normalizedPath === "displayname" && typeof value === "string") {
    patch.displayName = value.trim();
    return patch.displayName.length > 0;
  }
  if (normalizedPath === "externalid") {
    if (value === null) {
      patch.externalId = null;
      return true;
    }
    if (typeof value === "string") {
      patch.externalId = value.trim();
      return patch.externalId.length > 0;
    }
  }
  if (normalizedPath === "name.givenname") {
    patch.givenName = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    return true;
  }
  if (normalizedPath === "name.familyname") {
    patch.familyName = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    return true;
  }
  return false;
}

function scimPrimaryEmail(input: z.output<typeof scimCreateUserBody>): string | undefined {
  const primary = input.emails?.find((email) => email.primary === true);
  return normalizeOptionalEmail(primary?.value ?? input.emails?.[0]?.value);
}

function scimDisplayName(input: z.output<typeof scimCreateUserBody>): string {
  const nameParts = [input.name?.givenName, input.name?.familyName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return (
    (input.displayName ?? input.name?.formatted ?? nameParts) || normalizeUserName(input.userName)
  );
}

function scimUserResource(user: ScimUserRecord, tenantSlug: string) {
  const location = `/api/scim/v2/${tenantSlug}/Users/${user.id}`;
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    externalId: user.externalId ?? undefined,
    userName: user.userName,
    active: user.active,
    displayName: user.displayName,
    name: {
      formatted: user.displayName,
      ...(user.givenName === null ? {} : { givenName: user.givenName }),
      ...(user.familyName === null ? {} : { familyName: user.familyName }),
    },
    emails:
      user.email === null
        ? []
        : [
            {
              value: user.email,
              primary: true,
            },
          ],
    meta: {
      resourceType: "User",
      created: user.createdAt,
      lastModified: user.updatedAt,
      location,
    },
  };
}

interface ScimGroupPatch {
  readonly name?: string | undefined;
  readonly externalId?: string | null | undefined;
  readonly addMembers: readonly string[];
  readonly removeMembers: readonly string[];
  readonly replaceMembers?: readonly string[] | undefined;
}

function scimPatchGroupInput(
  operations: z.output<typeof scimPatchGroupBody>["Operations"],
): ScimGroupPatch | "unsupported" {
  const patch: {
    name?: string;
    externalId?: string | null;
    addMembers: string[];
    removeMembers: string[];
    replaceMembers?: string[];
  } = { addMembers: [], removeMembers: [] };
  for (const operation of operations) {
    const op = operation.op;
    if (op !== "replace" && op !== "add" && op !== "remove") {
      return "unsupported";
    }
    if (operation.path === undefined) {
      if (op === "remove" || !applyScimGroupPatchObject(patch, operation.value)) {
        return "unsupported";
      }
      continue;
    }
    if (!applyScimGroupPatchPath(patch, op, operation.path, operation.value)) {
      return "unsupported";
    }
  }
  return patch;
}

function applyScimGroupPatchObject(
  patch: {
    name?: string;
    externalId?: string | null;
    addMembers: string[];
    removeMembers: string[];
    replaceMembers?: string[];
  },
  value: unknown,
): boolean {
  const record = readRecord(value);
  if (record === undefined) {
    return false;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (!applyScimGroupPatchPath(patch, "replace", key, entry)) {
      return false;
    }
  }
  return true;
}

function applyScimGroupPatchPath(
  patch: {
    name?: string;
    externalId?: string | null;
    addMembers: string[];
    removeMembers: string[];
    replaceMembers?: string[];
  },
  op: "add" | "replace" | "remove",
  path: string,
  value: unknown,
): boolean {
  const normalizedPath = path.trim().toLowerCase();
  if (normalizedPath === "displayname") {
    if (op === "remove" || typeof value !== "string" || value.trim().length === 0) {
      return false;
    }
    patch.name = value.trim();
    return true;
  }
  if (normalizedPath === "externalid") {
    if (op === "remove" || value === null) {
      patch.externalId = null;
      return true;
    }
    if (typeof value === "string") {
      patch.externalId = value.trim();
      return patch.externalId.length > 0;
    }
    return false;
  }
  if (normalizedPath === "members") {
    const members = scimGroupMemberValuesFromUnknown(value);
    if (members === undefined) {
      return false;
    }
    if (op === "remove") {
      patch.removeMembers.push(...members);
      return true;
    }
    if (op === "replace") {
      patch.replaceMembers = [...members];
      return true;
    }
    patch.addMembers.push(...members);
    return true;
  }
  const memberValue = /^members\[value\s+eq\s+"(?<actorId>[^"]+)"\]$/iu.exec(path.trim())?.groups?.[
    "actorId"
  ];
  if (memberValue !== undefined && op === "remove") {
    const parsed = scimGroupMemberValue.safeParse(memberValue);
    if (!parsed.success) {
      return false;
    }
    patch.removeMembers.push(parsed.data);
    return true;
  }
  return false;
}

const scimGroupMemberValue = z.string().uuid();

function scimGroupMemberValues(
  members: z.output<typeof scimCreateGroupBody>["members"],
): readonly string[] {
  return [...new Set((members ?? []).map((member) => member.value))];
}

function scimGroupMemberValuesFromUnknown(value: unknown): readonly string[] | undefined {
  const values = Array.isArray(value) ? value : [value];
  const members = z.array(scimGroupMemberBody).safeParse(values);
  return members.success ? scimGroupMemberValues(members.data) : undefined;
}

async function reconcileScimGroupMembers(
  store: GroupsStore,
  input: {
    readonly orgId: string;
    readonly groupId: string;
    readonly actorId: string;
    readonly members: readonly string[];
  },
): Promise<void> {
  const current = await store.listGroupMembers(input.orgId, input.groupId);
  const next = new Set(input.members);
  await Promise.all(
    current
      .filter((member) => !next.has(member.actorId))
      .map((member) => store.removeGroupMember(input.orgId, input.groupId, member.actorId)),
  );
  const currentActorIds = new Set(current.map((member) => member.actorId));
  for (const actorId of next) {
    if (currentActorIds.has(actorId)) {
      continue;
    }
    await addScimGroupMember(store, {
      orgId: input.orgId,
      groupId: input.groupId,
      actorId,
      addedBy: input.actorId,
    });
  }
}

async function applyScimGroupMemberPatch(
  store: GroupsStore,
  input: {
    readonly orgId: string;
    readonly groupId: string;
    readonly actorId: string;
    readonly addMembers: readonly string[];
    readonly removeMembers: readonly string[];
    readonly replaceMembers?: readonly string[] | undefined;
  },
): Promise<void> {
  if (input.replaceMembers !== undefined) {
    await reconcileScimGroupMembers(store, {
      orgId: input.orgId,
      groupId: input.groupId,
      actorId: input.actorId,
      members: input.replaceMembers,
    });
    return;
  }
  for (const actorId of input.removeMembers) {
    await store.removeGroupMember(input.orgId, input.groupId, actorId);
  }
  for (const actorId of input.addMembers) {
    await addScimGroupMember(store, {
      orgId: input.orgId,
      groupId: input.groupId,
      actorId,
      addedBy: input.actorId,
    });
  }
}

async function addScimGroupMember(
  store: GroupsStore,
  input: {
    readonly orgId: string;
    readonly groupId: string;
    readonly actorId: string;
    readonly addedBy: string;
  },
): Promise<void> {
  try {
    await store.addGroupMember({
      orgId: input.orgId,
      groupId: input.groupId,
      actorId: input.actorId,
      role: "member",
      addedBy: input.addedBy,
    });
  } catch (error) {
    if (!(error instanceof GroupsConflictError)) {
      throw error;
    }
  }
}

async function scimGroupResource(store: GroupsStore, tenantSlug: string, group: GroupRecord) {
  const location = `/api/scim/v2/${tenantSlug}/Groups/${group.id}`;
  const members = await store.listGroupMembers(group.orgId, group.id);
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    externalId: group.externalId ?? undefined,
    displayName: group.name,
    members: members.map((member) => ({
      value: member.actorId,
      $ref: `/api/scim/v2/${tenantSlug}/Users/${member.actorId}`,
    })),
    meta: {
      resourceType: "Group",
      created: group.createdAt,
      lastModified: group.updatedAt,
      location,
    },
  };
}

interface ScimUserRow {
  readonly id: string;
  readonly org_id: string;
  readonly email: string | null;
  readonly display_name: string;
  readonly disabled_at: Date | null;
  readonly metadata: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function rowOrNull(row: ScimUserRow | undefined): ScimUserRecord | null {
  return row === undefined ? null : mapScimUserRow(row);
}

function mapScimUserRow(row: ScimUserRow): ScimUserRecord {
  const scim = readRecord(readRecord(row.metadata)?.["scim"]);
  const name = readRecord(scim?.["name"]);
  const email = normalizeOptionalEmail(row.email);
  return {
    id: row.id,
    orgId: row.org_id,
    userName: normalizeUserName(readString(scim?.["userName"]) ?? email ?? row.id),
    displayName: row.display_name,
    active: row.disabled_at === null,
    externalId: readString(scim?.["externalId"]) ?? null,
    email: email ?? null,
    givenName: readString(name?.["givenName"]) ?? null,
    familyName: readString(name?.["familyName"]) ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function scimActorMetadata(input: {
  readonly userName: string;
  readonly externalId?: string | undefined;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
}): JsonObject {
  const scim: Record<string, JsonValue> = { userName: input.userName };
  if (input.externalId !== undefined) {
    scim["externalId"] = input.externalId;
  }
  const name: Record<string, JsonValue> = {};
  if (input.givenName !== undefined) {
    name["givenName"] = input.givenName;
  }
  if (input.familyName !== undefined) {
    name["familyName"] = input.familyName;
  }
  if (Object.keys(name).length > 0) {
    scim["name"] = name;
  }
  return { scim };
}

function normalizeUserName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalEmail(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function resolveActiveScimTenant(
  params: unknown,
  options: RegisterTenantScimRoutesOptions,
): Promise<
  | { readonly success: true; readonly id: string; readonly slug: string }
  | { readonly success: false; readonly status: number; readonly body: unknown }
> {
  const parsed = scimTenantParams.safeParse(params);
  if (!parsed.success) {
    return {
      success: false,
      status: 400,
      body: scimError(400, "Invalid SCIM tenant slug."),
    };
  }
  const org = await options.orgs.findBySlug(parsed.data.tenantSlug);
  if (org === null || org.status !== "active") {
    return {
      success: false,
      status: 404,
      body: scimError(404, "SCIM tenant was not found."),
    };
  }
  return { success: true, id: org.id, slug: org.slug };
}

function scimError(status: number, detail: string) {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
  };
}
