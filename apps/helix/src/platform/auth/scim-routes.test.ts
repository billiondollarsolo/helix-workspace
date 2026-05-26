import fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  PostgresScimUserStore,
  registerTenantScimRoutes,
  type CreateScimUserInput,
  type ListScimUsersInput,
  type ScimUserListResult,
  type ScimUserRecord,
  type ScimUserStore,
  type UpdateScimUserInput,
} from "./scim-routes.js";
import { InMemoryGroupsStore } from "../admin/groups.js";
import type { OrgRecord, OrgStore } from "../tenancy/orgs.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function responseBody(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

describe("tenant SCIM discovery routes", () => {
  it("serves ServiceProviderConfig for active tenants without touching login state", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      documentationUri: "https://docs.helix.example/scim",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://docs.helix.example/scim",
      patch: { supported: true },
      filter: { supported: true, maxResults: 200 },
      authenticationSchemes: [{ type: "oauthbearertoken", primary: true }],
    });
    await app.close();
  });

  it("serves ResourceTypes and Schemas discovery documents", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
    });

    const resourceTypes = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ResourceTypes",
    });
    const schemas = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Schemas",
    });

    expect(resourceTypes.statusCode).toBe(200);
    expect(resourceTypes.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        {
          id: "User",
          endpoint: "/api/scim/v2/acme/Users",
          schema: "urn:ietf:params:scim:schemas:core:2.0:User",
        },
        {
          id: "Group",
          endpoint: "/api/scim/v2/acme/Groups",
          schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
        },
      ],
    });
    expect(schemas.statusCode).toBe(200);
    expect(schemas.json()).toMatchObject({
      totalResults: 2,
      Resources: [
        { id: "urn:ietf:params:scim:schemas:core:2.0:User" },
        { id: "urn:ietf:params:scim:schemas:core:2.0:Group" },
      ],
    });
    await app.close();
  });

  it("creates tenant-scoped SCIM Users without touching local login credentials", async () => {
    const store = new FakeScimUserStore();
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      users: store,
      actorFromRequest,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.write" }),
      payload: {
        userName: "CASEY@EXAMPLE.COM",
        externalId: "okta-123",
        name: { givenName: "Casey", familyName: "Ng", formatted: "Casey Ng" },
        emails: [{ value: "casey@example.com", primary: true }],
        active: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    expect(response.headers.location).toBe("/api/scim/v2/acme/Users/user-1");
    expect(response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: "user-1",
      externalId: "okta-123",
      userName: "casey@example.com",
      active: true,
      displayName: "Casey Ng",
      emails: [{ value: "casey@example.com", primary: true }],
      meta: {
        resourceType: "User",
        location: "/api/scim/v2/acme/Users/user-1",
      },
    });
    expect(store.created).toEqual([
      {
        orgId: "org-1",
        userName: "casey@example.com",
        displayName: "Casey Ng",
        active: true,
        externalId: "okta-123",
        email: "casey@example.com",
        givenName: "Casey",
        familyName: "Ng",
      },
    ]);
    expect(store.localLoginCredentialWrites).toBe(0);
    await app.close();
  });

  it("lists and fetches SCIM Users with userName filtering", async () => {
    const store = new FakeScimUserStore([
      scimUser({ id: "user-1", orgId: "org-1", userName: "casey@example.com" }),
    ]);
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      users: store,
      actorFromRequest,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Users?filter=userName%20eq%20%22casey%40example.com%22&startIndex=1&count=25",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.read" }),
    });
    const fetched = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Users/user-1",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.read" }),
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [{ id: "user-1", userName: "casey@example.com" }],
    });
    expect(store.listCalls).toEqual([
      { orgId: "org-1", startIndex: 1, count: 25, filterUserName: "casey@example.com" },
    ]);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      id: "user-1",
      userName: "casey@example.com",
      active: true,
    });
    await app.close();
  });

  it("patches SCIM Users for profile updates, deprovision, and reactivation", async () => {
    const store = new FakeScimUserStore([
      scimUser({ id: "user-1", orgId: "org-1", userName: "casey@example.com" }),
    ]);
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      users: store,
      actorFromRequest,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/scim/v2/acme/Users/user-1",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.write" }),
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", path: "active", value: false },
          { op: "replace", path: "displayName", value: "Casey Renamed" },
          { op: "replace", path: "externalId", value: "okta-456" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "user-1",
      userName: "casey@example.com",
      active: false,
      displayName: "Casey Renamed",
      externalId: "okta-456",
    });
    expect(store.updated).toEqual([
      {
        orgId: "org-1",
        id: "user-1",
        active: false,
        displayName: "Casey Renamed",
        externalId: "okta-456",
      },
    ]);
    expect(store.localLoginCredentialWrites).toBe(0);
    await app.close();
  });

  it("replaces and deletes SCIM Users without local login credential writes", async () => {
    const store = new FakeScimUserStore([
      scimUser({ id: "user-1", orgId: "org-1", userName: "casey@example.com" }),
    ]);
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      users: store,
      actorFromRequest,
    });

    const replaced = await app.inject({
      method: "PUT",
      url: "/api/scim/v2/acme/Users/user-1",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.write" }),
      payload: {
        userName: "casey.renamed@example.com",
        externalId: "okta-789",
        displayName: "Casey Replaced",
        active: true,
        emails: [{ value: "casey.renamed@example.com", primary: true }],
        name: { givenName: "Casey", familyName: "Replaced" },
      },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/scim/v2/acme/Users/user-1",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.write" }),
    });

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      id: "user-1",
      userName: "casey.renamed@example.com",
      displayName: "Casey Replaced",
      externalId: "okta-789",
      active: true,
    });
    expect(deleted.statusCode).toBe(204);
    expect(store.updated[0]).toMatchObject({
      orgId: "org-1",
      id: "user-1",
      userName: "casey.renamed@example.com",
      displayName: "Casey Replaced",
      externalId: "okta-789",
      email: "casey.renamed@example.com",
      givenName: "Casey",
      familyName: "Replaced",
    });
    expect(store.deleted).toEqual([{ orgId: "org-1", id: "user-1" }]);
    expect(store.localLoginCredentialWrites).toBe(0);
    await app.close();
  });

  it("protects SCIM Users with tenant-scoped provisioning scopes and leaves unconfigured Groups pending", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      users: new FakeScimUserStore(),
      actorFromRequest,
    });

    const missingAuth = await app.inject({ method: "GET", url: "/api/scim/v2/acme/Users" });
    const crossTenant = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Users",
      headers: scimHeaders({ orgId: "org-2", scopes: "scim.users.read" }),
    });
    const wrongScope = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.read" }),
      payload: { userName: "casey@example.com" },
    });
    const groups = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Groups",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.write" }),
    });

    expect(missingAuth.statusCode).toBe(401);
    expect(missingAuth.json()).toMatchObject({ status: "401" });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json()).toMatchObject({ status: "403" });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({
      status: "403",
      detail: "SCIM Users permission denied.",
    });
    expect(groups.statusCode).toBe(501);
    expect(groups.json()).toMatchObject({
      status: "501",
      detail: "Groups SCIM provisioning is not configured.",
    });
    await app.close();
  });

  it("creates, reconciles, lists, fetches, and deletes SCIM Groups", async () => {
    const groups = new InMemoryGroupsStore();
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      groups,
      actorFromRequest,
    });
    const memberOne = "11111111-1111-4111-8111-111111111111";
    const memberTwo = "22222222-2222-4222-8222-222222222222";

    const created = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Groups",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.groups.write" }),
      payload: {
        displayName: "Engineering",
        externalId: "okta-group-1",
        members: [{ value: memberOne }],
      },
    });
    const groupId = String(responseBody(created).id);
    const listed = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Groups?filter=displayName%20eq%20%22Engineering%22&count=10",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.groups.read" }),
    });
    const fetched = await app.inject({
      method: "GET",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.groups.read" }),
    });
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.groups.write" }),
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", path: "displayName", value: "Platform Engineering" },
          { op: "add", path: "members", value: [{ value: memberTwo }] },
          { op: "remove", path: `members[value eq "${memberOne}"]` },
        ],
      },
    });
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.groups.write" }),
      payload: {
        displayName: "Engineering Leads",
        externalId: "okta-group-2",
        members: [{ value: memberOne }],
      },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.groups.write" }),
    });

    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/api/scim/v2/acme/Groups/${groupId}`);
    expect(created.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Engineering",
      externalId: "okta-group-1",
      members: [{ value: memberOne }],
      meta: { resourceType: "Group" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: groupId, displayName: "Engineering" }],
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: groupId, members: [{ value: memberOne }] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      displayName: "Platform Engineering",
      members: [{ value: memberTwo }],
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      displayName: "Engineering Leads",
      externalId: "okta-group-2",
      members: [{ value: memberOne }],
    });
    expect(deleted.statusCode).toBe(204);
    expect(await groups.getGroup("org-1", groupId)).toBeNull();
    await app.close();
  });

  it("protects SCIM Groups with tenant-scoped provisioning scopes", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      groups: new InMemoryGroupsStore(),
      actorFromRequest,
    });

    const missingAuth = await app.inject({ method: "GET", url: "/api/scim/v2/acme/Groups" });
    const crossTenant = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Groups",
      headers: scimHeaders({ orgId: "org-2", scopes: "scim.groups.read" }),
    });
    const wrongScope = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Groups",
      headers: scimHeaders({ orgId: "org-1", scopes: "scim.users.write" }),
      payload: { displayName: "Engineering" },
    });

    expect(missingAuth.statusCode).toBe(401);
    expect(missingAuth.json()).toMatchObject({ status: "401" });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json()).toMatchObject({ status: "403" });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({
      status: "403",
      detail: "SCIM Groups permission denied.",
    });
    await app.close();
  });

  it("does not serve SCIM discovery for invalid, missing, or inactive tenants", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({
        suspended: orgRecord({ id: "org-suspended", slug: "suspended", status: "suspended" }),
      }),
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/scim/v2/Bad_Tenant/ServiceProviderConfig",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/scim/v2/missing/ServiceProviderConfig",
    });
    const suspended = await app.inject({
      method: "GET",
      url: "/api/scim/v2/suspended/ServiceProviderConfig",
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers["content-type"]).toContain("application/scim+json");
    expect(invalid.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "400",
      detail: "Invalid SCIM tenant slug.",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/scim+json");
    expect(missing.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "SCIM tenant was not found.",
    });
    expect(suspended.statusCode).toBe(404);
    expect(suspended.headers["content-type"]).toContain("application/scim+json");
    expect(suspended.json()).toMatchObject({
      status: "404",
      detail: "SCIM tenant was not found.",
    });
    await app.close();
  });
});

describe("PostgresScimUserStore", () => {
  it("creates SCIM users by inserting tenant-scoped actors only", async () => {
    const createdAt = new Date("2026-05-24T10:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          id: "user-1",
          org_id: "org-1",
          email: "casey@example.com",
          display_name: "Casey Ng",
          disabled_at: null,
          metadata: {
            scim: {
              userName: "casey@example.com",
              externalId: "okta-123",
              name: { givenName: "Casey", familyName: "Ng" },
            },
          },
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
    ]);
    const store = new PostgresScimUserStore(recording.sql);

    await expect(
      store.createUser({
        orgId: "org-1",
        userName: "CASEY@EXAMPLE.COM",
        displayName: "Casey Ng",
        active: true,
        externalId: "okta-123",
        email: "casey@example.com",
        givenName: "Casey",
        familyName: "Ng",
      }),
    ).resolves.toMatchObject({
      id: "user-1",
      orgId: "org-1",
      userName: "casey@example.com",
      active: true,
      externalId: "okta-123",
    });
    expect(recording.calls[0]?.text).toContain("insert into actors");
    expect(recording.calls[0]?.text).not.toContain('insert into "user"');
    expect(recording.calls[0]?.text).not.toContain("insert into account");
    expect(recording.calls[0]?.values).toContain("org-1");
    expect(recording.calls[0]?.values).toContain("casey@example.com");
  });

  it("lists and patches SCIM users through org-scoped actor rows", async () => {
    const createdAt = new Date("2026-05-24T10:00:00.000Z");
    const updatedAt = new Date("2026-05-24T10:05:00.000Z");
    const recording = createRecordingSql([
      [{ row_count: 1 }],
      [
        {
          id: "user-1",
          org_id: "org-1",
          email: "casey@example.com",
          display_name: "Casey Ng",
          disabled_at: null,
          metadata: { scim: { userName: "casey@example.com" } },
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
      [
        {
          id: "user-1",
          org_id: "org-1",
          email: "casey@example.com",
          display_name: "Casey Ng",
          disabled_at: null,
          metadata: { scim: { userName: "casey@example.com" } },
          created_at: createdAt,
          updated_at: createdAt,
        },
      ],
      [
        {
          id: "user-1",
          org_id: "org-1",
          email: "casey@example.com",
          display_name: "Casey Disabled",
          disabled_at: updatedAt,
          metadata: {
            scim: {
              userName: "casey@example.com",
              externalId: "okta-456",
              name: {},
            },
          },
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
      [
        {
          id: "user-1",
          org_id: "org-1",
          email: "casey@example.com",
          display_name: "Casey Disabled",
          disabled_at: updatedAt,
          metadata: {
            scim: {
              userName: "casey@example.com",
              externalId: "okta-456",
              name: {},
            },
          },
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
      [
        {
          id: "user-1",
          org_id: "org-1",
          email: "casey@example.com",
          display_name: "Casey Disabled",
          disabled_at: updatedAt,
          metadata: {
            scim: {
              userName: "casey@example.com",
              externalId: "okta-456",
              name: {},
            },
          },
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
    ]);
    const store = new PostgresScimUserStore(recording.sql);

    await expect(
      store.listUsers({
        orgId: "org-1",
        startIndex: 1,
        count: 25,
        filterUserName: "casey@example.com",
      }),
    ).resolves.toMatchObject({ totalResults: 1, users: [{ id: "user-1" }] });
    await expect(
      store.updateUser({
        orgId: "org-1",
        id: "user-1",
        active: false,
        displayName: "Casey Disabled",
        externalId: "okta-456",
      }),
    ).resolves.toMatchObject({
      id: "user-1",
      active: false,
      displayName: "Casey Disabled",
      externalId: "okta-456",
    });
    await expect(store.deleteUser({ orgId: "org-1", id: "user-1" })).resolves.toMatchObject({
      id: "user-1",
      active: false,
    });
    expect(recording.calls[0]?.text).toContain("from actors");
    expect(recording.calls[0]?.text).toContain("where org_id =");
    expect(recording.calls[2]?.text).toContain("where org_id =");
    expect(recording.calls[3]?.text).toContain("update actors");
    expect(recording.calls[3]?.text).toContain("and type = 'user'");
    expect(recording.calls[5]?.text).toContain("update actors");
    expect(recording.calls[5]?.text).toContain("disabled_at =");
    expect(recording.calls[5]?.text).not.toContain("delete from actors");
  });
});

function orgStore(orgs: Record<string, OrgRecord>): Pick<OrgStore, "findBySlug"> {
  return {
    async findBySlug(slug) {
      return orgs[slug] ?? null;
    },
  };
}

function scimHeaders(input: { readonly orgId: string; readonly scopes: string }) {
  return {
    "x-helix-actor-id": "scim-client",
    "x-helix-actor-type": "service_account",
    "x-helix-org-id": input.orgId,
    "x-helix-scopes": input.scopes,
  };
}

class FakeScimUserStore implements ScimUserStore {
  readonly created: CreateScimUserInput[] = [];
  readonly listCalls: ListScimUsersInput[] = [];
  readonly updated: UpdateScimUserInput[] = [];
  readonly deleted: { readonly orgId: string; readonly id: string }[] = [];
  readonly localLoginCredentialWrites = 0;

  constructor(private users: readonly ScimUserRecord[] = []) {}

  async listUsers(input: ListScimUsersInput): Promise<ScimUserListResult> {
    this.listCalls.push(input);
    const users =
      input.filterUserName === undefined
        ? this.users
        : this.users.filter((user) => user.userName === input.filterUserName);
    return { totalResults: users.length, users };
  }

  async getUser(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<ScimUserRecord | null> {
    return this.users.find((user) => user.orgId === input.orgId && user.id === input.id) ?? null;
  }

  async createUser(input: CreateScimUserInput): Promise<ScimUserRecord> {
    this.created.push(input);
    return scimUser({
      id: "user-1",
      orgId: input.orgId,
      userName: input.userName,
      displayName: input.displayName,
      active: input.active,
      externalId: input.externalId ?? null,
      email: input.email ?? input.userName,
      givenName: input.givenName ?? null,
      familyName: input.familyName ?? null,
    });
  }

  async updateUser(input: UpdateScimUserInput): Promise<ScimUserRecord | null> {
    this.updated.push(input);
    const user = this.users.find(
      (candidate) => candidate.orgId === input.orgId && candidate.id === input.id,
    );
    if (user === undefined) {
      return null;
    }
    const updated = {
      ...user,
      ...(input.userName === undefined ? {} : { userName: input.userName }),
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.givenName === undefined ? {} : { givenName: input.givenName }),
      ...(input.familyName === undefined ? {} : { familyName: input.familyName }),
      updatedAt: "2026-05-24T10:05:00.000Z",
    };
    this.users = this.users.map((candidate) => (candidate.id === input.id ? updated : candidate));
    return updated;
  }

  async deleteUser(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<ScimUserRecord | null> {
    this.deleted.push(input);
    return this.updateUser({ ...input, active: false });
  }
}

function scimUser(overrides: Partial<ScimUserRecord>): ScimUserRecord {
  return {
    id: "user-1",
    orgId: "org-1",
    userName: "casey@example.com",
    displayName: "Casey Ng",
    active: true,
    externalId: "okta-123",
    email: "casey@example.com",
    givenName: "Casey",
    familyName: "Ng",
    createdAt: "2026-05-24T10:00:00.000Z",
    updatedAt: "2026-05-24T10:00:00.000Z",
    ...overrides,
  };
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const sql = tag as unknown as postgres.Sql;
  sql.json = (value: unknown) => value as never;
  return { sql, calls };
}

function orgRecord(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    id: "org-1",
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
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
