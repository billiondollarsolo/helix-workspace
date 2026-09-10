import fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import {
  PostgresAdminUsersStore,
  canReadAdminUsers,
  decodeAdminUsersCursor,
  disableActorForOffboard,
  encodeAdminUsersCursor,
  offboardUser,
  registerAdminUsersRoutes,
  registerPeopleDirectoryRoutes,
  type AdminUserRecord,
  type AdminUsersStore,
  type CreateAdminUserInput,
  type ListAdminUsersInput,
  type OffboardAgentCredentialRecord,
  type OffboardAgentCredentialStore,
  type OffboardAppPasswordRecord,
  type OffboardAppPasswordStore,
} from "./admin-users.js";
import { buildAdminOrgInviteUrl, uniqueEmails } from "./admin-user-provisioning.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

describe("admin users routes", () => {
  it("audits a security-admin reset and refuses self-reset", async () => {
    const targetId = "55555555-5555-4555-8555-555555555555";
    const store = new FakeAdminUsersStore([], true);
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store,
      actorFromRequest,
    });
    const headers = {
      "x-helix-actor-id": actorId,
      "x-helix-org-id": orgId,
      "x-helix-scopes": "admin.security",
    };

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/mfa/reset`,
      headers,
    });
    expect(reset.statusCode).toBe(204);
    expect(store.resets).toEqual([
      {
        orgId,
        targetActorId: targetId,
        performedByActorId: actorId,
      },
    ]);

    const self = await app.inject({
      method: "POST",
      url: `/api/admin/users/${actorId}/mfa/reset`,
      headers,
    });
    expect(self.statusCode).toBe(409);
    expect(store.resets).toHaveLength(1);
  });

  it("consumes the user-admin role binding", () => {
    expect(
      canReadAdminUsers({
        id: actorId,
        orgId,
        type: "user",
        scopes: [],
        roleBindings: [
          {
            roleId: "77777777-7777-4777-8777-777777777778",
            allow: ["admin.users"],
            deny: [],
            scope: { type: "org" },
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns org-scoped users with filters and cursor pagination", async () => {
    const store = new FakeAdminUsersStore([
      userRecord("55555555-5555-4555-8555-555555555555", "2026-05-20T12:05:00.000Z"),
      userRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
      userRecord("33333333-3333-4333-8333-333333333333", "2026-05-20T12:03:00.000Z"),
    ]);
    const cursor = encodeAdminUsersCursor(
      userRecord("66666666-6666-4666-8666-666666666666", "2026-05-20T12:06:00.000Z"),
    );
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: `/api/admin/users?limit=2&query=ali&type=user&includeDisabled=true&cursor=${cursor}`,
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.users",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      users: [
        userRecord("55555555-5555-4555-8555-555555555555", "2026-05-20T12:05:00.000Z"),
        userRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
      ],
      nextCursor: encodeAdminUsersCursor(
        userRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
      ),
    });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      orgId,
      includeDisabled: true,
      limit: 3,
      query: "ali",
      type: "user",
    });
    expect(store.calls[0]?.cursor).toEqual(decodeAdminUsersCursor(cursor));
  });

  it("defaults to active users in the current org", async () => {
    const store = new FakeAdminUsersStore([]);
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.*",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(store.calls[0]).toMatchObject({
      orgId,
      includeDisabled: false,
      limit: 51,
    });
  });

  it("requires admin users scope", async () => {
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.audit",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Admin users permission denied.",
      requiredScope: "admin.users",
    });
  });

  it("rejects malformed cursors before touching the store", async () => {
    const store = new FakeAdminUsersStore([]);
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users?cursor=not-a-cursor",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.users",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid admin users cursor." });
    expect(store.calls).toEqual([]);
  });
});

const adminHeaders = {
  "x-helix-actor-id": actorId,
  "x-helix-org-id": orgId,
  "x-helix-scopes": "admin.users",
} as const;

const wildcardAdminHeaders = {
  "x-helix-actor-id": actorId,
  "x-helix-org-id": orgId,
  "x-helix-scopes": "admin.*",
} as const;

const memberHeaders = {
  "x-helix-actor-id": actorId,
  "x-helix-org-id": orgId,
  "x-helix-scopes": "mail.read",
} as const;

describe("admin user create", () => {
  it("creates a member with Better Auth-backed fields for an admin.users actor", async () => {
    const store = new FakeAdminUsersStore([]);
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "Mina@Example.com",
        password: "correct-horse-battery-staple",
        displayName: "Mina Park",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: expect.objectContaining({
        orgId,
        type: "user",
        email: "mina@example.com",
        displayName: "Mina Park",
        disabledAt: null,
      }),
    });
    expect(store.creates).toEqual([
      {
        orgId,
        email: "mina@example.com",
        displayName: "Mina Park",
        password: "correct-horse-battery-staple",
        role: "member",
        performedByActorId: actorId,
      },
    ]);
    await app.close();
  });

  it("denies create to non-admin actors", async () => {
    const store = new FakeAdminUsersStore([]);
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: memberHeaders,
      payload: {
        email: "mina@example.com",
        password: "correct-horse-battery-staple",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Admin users permission denied.",
      requiredScope: "admin.users",
    });
    expect(store.creates).toEqual([]);
    await app.close();
  });

  it("refuses to create an admin unless the caller holds admin.*", async () => {
    const store = new FakeAdminUsersStore([]);
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });

    const denied = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: adminHeaders,
      payload: {
        email: "admin@example.com",
        password: "correct-horse-battery-staple",
        role: "admin",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(store.creates).toEqual([]);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: wildcardAdminHeaders,
      payload: {
        email: "admin@example.com",
        password: "correct-horse-battery-staple",
        role: "admin",
      },
    });
    expect(allowed.statusCode).toBe(201);
    expect(store.creates[0]?.role).toBe("admin");
    await app.close();
  });
});

describe("admin user invite", () => {
  it("issues org-scoped invites and enqueues outbox email without SaaS signup", async () => {
    const store = new FakeAdminUsersStore([]);
    const issued: unknown[] = [];
    const outbox: unknown[] = [];
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store,
      actorFromRequest,
      invites: {
        invites: {
          async issue(input) {
            issued.push(input);
            return {
              orgId: input.orgId,
              invitedByActorId: input.invitedByActorId,
              email: input.email,
              token: `invite-token-${input.email}`,
              expiresAt: new Date("2026-09-17T00:00:00.000Z"),
              acceptedAt: null,
              acceptedByActorId: null,
              metadata: input.metadata ?? {},
            };
          },
          async accept() {
            return { status: "not_found" };
          },
        },
        outbox: {
          async insert(message) {
            outbox.push(message);
            return "outbox-1";
          },
        },
        findOrgById: async () => ({ slug: "acme" }),
        publicBaseUrl: "https://helix.example",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/invites",
      headers: adminHeaders,
      payload: { emails: [" Ada@Example.com ", "ada@example.com", "grace@example.com"] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted", inviteCount: 2, skippedCount: 0 });
    expect(issued).toEqual([
      {
        orgId,
        invitedByActorId: actorId,
        email: "ada@example.com",
        metadata: { source: "admin", role: "member" },
      },
      {
        orgId,
        invitedByActorId: actorId,
        email: "grace@example.com",
        metadata: { source: "admin", role: "member" },
      },
    ]);
    expect(outbox).toEqual([
      {
        subject: "signup.onboarding_invite_email.send",
        payload: {
          orgId,
          orgSlug: "acme",
          actorId,
          email: "ada@example.com",
          inviteUrl: "https://helix.example/signup/invite?token=invite-token-ada%40example.com",
          source: "admin",
        },
      },
      {
        subject: "signup.onboarding_invite_email.send",
        payload: {
          orgId,
          orgSlug: "acme",
          actorId,
          email: "grace@example.com",
          inviteUrl: "https://helix.example/signup/invite?token=invite-token-grace%40example.com",
          source: "admin",
        },
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain("invite-token");
    await app.close();
  });

  it("denies invite to non-admin actors and does not write the outbox", async () => {
    const outbox: unknown[] = [];
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      invites: {
        invites: {
          async issue() {
            throw new Error("invite should not issue");
          },
          async accept() {
            return { status: "not_found" };
          },
        },
        outbox: {
          async insert(message) {
            outbox.push(message);
            return "outbox-1";
          },
        },
        findOrgById: async () => ({ slug: "acme" }),
        publicBaseUrl: "https://helix.example",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/invites",
      headers: memberHeaders,
      payload: { emails: ["ada@example.com"] },
    });

    expect(response.statusCode).toBe(403);
    expect(outbox).toEqual([]);
    await app.close();
  });

  it("skips emails that already have an actor in the org", async () => {
    const existing = userRecord("55555555-5555-4555-8555-555555555555", "2026-05-20T12:05:00.000Z");
    const store = new FakeAdminUsersStore([{ ...existing, email: "ada@example.com" }]);
    const issued: string[] = [];
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store,
      actorFromRequest,
      invites: {
        invites: {
          async issue(input) {
            issued.push(input.email);
            return {
              orgId: input.orgId,
              invitedByActorId: input.invitedByActorId,
              email: input.email,
              token: "token",
              expiresAt: new Date("2026-09-17T00:00:00.000Z"),
              acceptedAt: null,
              acceptedByActorId: null,
              metadata: {},
            };
          },
          async accept() {
            return { status: "not_found" };
          },
        },
        outbox: {
          async insert() {
            return "outbox-1";
          },
        },
        findOrgById: async () => ({ slug: "acme" }),
        publicBaseUrl: "https://helix.example",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/invites",
      headers: adminHeaders,
      payload: { emails: ["ada@example.com", "new@example.com"] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted", inviteCount: 1, skippedCount: 1 });
    expect(issued).toEqual(["new@example.com"]);
    await app.close();
  });

  it("accepts an invite with a password without requiring SaaS signup", async () => {
    const store = new FakeAdminUsersStore([]);
    const accepted: unknown[] = [];
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store,
      actorFromRequest,
      invites: {
        invites: {
          async issue() {
            throw new Error("accept should not issue");
          },
          async accept() {
            return { status: "not_found" };
          },
          async findActive() {
            return {
              orgId,
              invitedByActorId: actorId,
              email: "ada@example.com",
              expiresAt: new Date("2026-09-17T00:00:00.000Z"),
              acceptedAt: null,
              acceptedByActorId: null,
              metadata: { source: "admin", role: "member" },
            };
          },
          async markAccepted(input) {
            accepted.push(input);
            return {
              orgId,
              invitedByActorId: actorId,
              email: "ada@example.com",
              expiresAt: new Date("2026-09-17T00:00:00.000Z"),
              acceptedAt: new Date("2026-09-10T00:00:00.000Z"),
              acceptedByActorId: input.acceptedByActorId,
              metadata: { source: "admin" },
            };
          },
        },
        outbox: {
          async insert() {
            return "outbox-1";
          },
        },
        findOrgById: async () => ({ slug: "acme" }),
        publicBaseUrl: "https://helix.example",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: {
        token: "invite-token",
        password: "correct-horse-battery-staple",
        displayName: "Ada Lovelace",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "accepted",
      user: {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        orgId,
      },
      org: { slug: "acme" },
    });
    expect(store.creates).toHaveLength(1);
    expect(store.creates[0]).toMatchObject({
      orgId,
      email: "ada@example.com",
      password: "correct-horse-battery-staple",
      role: "member",
      performedByActorId: actorId,
    });
    expect(accepted).toEqual([
      { token: "invite-token", acceptedByActorId: response.json().user.id },
    ]);
    await app.close();
  });
});

describe("admin user suspend", () => {
  it("POST /api/admin/users/:actorId/suspend reuses the offboard cascade", async () => {
    const targetActorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const appPasswords = new RecordingAppPasswordStore([
      { id: "apw-route", orgId, actorId: targetActorId, revokedAt: null },
    ]);
    const credentials = new RecordingAgentCredentialStore([
      { clientId: "client-route", orgId, actorId: targetActorId, revokedAt: null },
    ]);
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async () => true,
        disableActor: async () => true,
        revokeSessionsForActor: async () => 2,
        appPasswords,
        agentCredentials: credentials,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetActorId}/suspend`,
      headers: adminHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      suspend: {
        actorId: targetActorId,
        orgId,
        disabled: true,
        sessionsRevoked: 2,
        appPasswordsRevoked: 1,
        agentCredentialsRevoked: 1,
      },
    });
    await app.close();
  });

  it("denies suspend to non-admin actors", async () => {
    const targetActorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let disableCalled = 0;
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async () => true,
        disableActor: async () => {
          disableCalled += 1;
          return true;
        },
        revokeSessionsForActor: async () => 0,
        appPasswords: new RecordingAppPasswordStore([]),
        agentCredentials: new RecordingAgentCredentialStore([]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetActorId}/suspend`,
      headers: memberHeaders,
    });

    expect(response.statusCode).toBe(403);
    expect(disableCalled).toBe(0);
    await app.close();
  });

  it("refuses self-suspend", async () => {
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async () => true,
        revokeSessionsForActor: async () => 0,
        appPasswords: new RecordingAppPasswordStore([]),
        agentCredentials: new RecordingAgentCredentialStore([]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${actorId}/suspend`,
      headers: adminHeaders,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Administrators cannot suspend themselves.",
    });
    await app.close();
  });
});

describe("admin user provisioning helpers", () => {
  it("builds a single-tenant invite URL without a SaaS tenant subdomain", () => {
    expect(buildAdminOrgInviteUrl("https://helix.example/base", "token+1")).toBe(
      "https://helix.example/signup/invite?token=token%2B1",
    );
  });

  it("deduplicates invite emails", () => {
    expect(uniqueEmails([" Ada@Example.com ", "ada@example.com", "grace@example.com"])).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
  });

  it("disableActorForOffboard suspends the membership as SCIM active=false does", async () => {
    const disabledAt = new Date("2026-09-10T12:00:00.000Z");
    const recording = createRecordingSql([[{ id: actorId }], []]);
    const disabled = await disableActorForOffboard(recording.sql, {
      orgId,
      actorId,
      disabledAt,
    });
    expect(disabled).toBe(true);
    expect(recording.calls[0]?.text).toContain("update actors");
    expect(recording.calls[0]?.text).toContain("disabled_at");
    expect(recording.calls[1]?.text).toContain("update organization_memberships");
    expect(recording.calls[1]?.text).toContain("status = ");
    expect(recording.calls[1]?.values).toContain(orgId);
    expect(recording.calls[1]?.values).toContain(actorId);
    expect(recording.calls[1]?.values).toContain(disabledAt);
  });
});

describe("people directory routes", () => {
  it("returns active org users for authenticated non-admin actors", async () => {
    const store = new FakeAdminUsersStore([
      {
        ...userRecord("55555555-5555-4555-8555-555555555555", "2026-05-20T12:05:00.000Z"),
        displayName: "Mina Park",
        email: "mina@example.com",
      },
      {
        ...userRecord("44444444-4444-4444-8444-444444444444", "2026-05-20T12:04:00.000Z"),
        displayName: "",
        email: "fallback@example.com",
      },
    ]);
    const app = fastify();
    await registerPeopleDirectoryRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: "/api/people?limit=10&query=mina",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "docs.read",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      people: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          email: "mina@example.com",
          displayName: "Mina Park",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          email: "fallback@example.com",
          displayName: "fallback@example.com",
        },
      ],
    });
    expect(store.calls).toEqual([
      {
        orgId,
        includeDisabled: false,
        limit: 10,
        query: "mina",
        type: "user",
      },
    ]);
  });

  it("rejects malformed people directory queries before touching the store", async () => {
    const store = new FakeAdminUsersStore([]);
    const app = fastify();
    await registerPeopleDirectoryRoutes(app, { store, actorFromRequest });

    const response = await app.inject({
      method: "GET",
      url: "/api/people?limit=500",
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid people directory query." });
    expect(store.calls).toEqual([]);
  });
});

describe("PostgresAdminUsersStore", () => {
  it("reads users from actors with org, query, type, disabled, and cursor filters", async () => {
    const disabledAt = new Date("2026-05-20T13:00:00.000Z");
    const createdAt = new Date("2026-05-20T12:00:00.000Z");
    const updatedAt = new Date("2026-05-20T12:30:00.000Z");
    const cursorCreatedAt = new Date("2026-05-20T14:00:00.000Z");
    const cursorId = "77777777-7777-4777-8777-777777777777";
    const recording = createRecordingSql([
      [
        {
          id: actorId,
          org_id: orgId,
          type: "agent",
          email: "agent@example.com",
          display_name: "Agent One",
          scopes: ["mail.read"],
          disabled_at: disabledAt,
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
    ]);
    const store = new PostgresAdminUsersStore(recording.sql);

    const users = await store.listUsers({
      orgId,
      includeDisabled: true,
      limit: 25,
      query: "Agent_One",
      type: "agent",
      cursor: { createdAt: cursorCreatedAt, id: cursorId },
    });

    expect(users).toEqual([
      {
        id: actorId,
        orgId,
        type: "agent",
        email: "agent@example.com",
        displayName: "Agent One",
        scopes: ["mail.read"],
        disabledAt: disabledAt.toISOString(),
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
    expect(recording.calls[0]?.text).toContain("from actors");
    expect(recording.calls[0]?.text).toContain("where org_id =");
    expect(recording.calls[0]?.text).toContain("type =");
    expect(recording.calls[0]?.text).toContain("disabled_at is null");
    expect(recording.calls[0]?.text).toContain("lower(coalesce(email, ''))");
    expect(recording.calls[0]?.text).toContain("(created_at, id) <");
    expect(recording.calls[0]?.values).toContain(orgId);
    expect(recording.calls[0]?.values).toContain("agent");
    expect(recording.calls[0]?.values).toContain(true);
    expect(recording.calls[0]?.values).toContain("agent_one");
    expect(recording.calls[0]?.values).toContain("%agent\\_one%");
    expect(recording.calls[0]?.values).toContain(cursorCreatedAt);
    expect(recording.calls[0]?.values).toContain(cursorId);
    expect(recording.calls[0]?.values).toContain(25);
  });
});

describe("offboardUser revoke cascade (E7.2)", () => {
  it("disables actor and revokes sessions, app passwords, and agent credentials", async () => {
    const targetActorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherActorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const at = new Date("2026-08-03T12:00:00.000Z");

    const disabled: string[] = [];
    const sessions: string[] = [];
    const appPasswords = new RecordingAppPasswordStore([
      {
        id: "apw-1",
        orgId,
        actorId: targetActorId,
        revokedAt: null,
      },
      {
        id: "apw-2",
        orgId,
        actorId: targetActorId,
        revokedAt: null,
      },
      {
        id: "apw-other",
        orgId,
        actorId: otherActorId,
        revokedAt: null,
      },
    ]);
    const credentials = new RecordingAgentCredentialStore([
      {
        clientId: "client-1",
        orgId,
        actorId: targetActorId,
        revokedAt: null,
      },
      {
        clientId: "client-other",
        orgId,
        actorId: otherActorId,
        revokedAt: null,
      },
    ]);

    const result = await offboardUser(
      { orgId, actorId: targetActorId, at },
      {
        resolveTargetInOrg: async (input) => {
          expect(input).toEqual({ orgId, actorId: targetActorId });
          return true;
        },
        disableActor: async (input) => {
          disabled.push(input.actorId);
          expect(input).toEqual({
            orgId,
            actorId: targetActorId,
            disabledAt: at,
          });
          return true;
        },
        revokeSessionsForActor: async (input) => {
          expect(input).toEqual({ orgId, actorId: targetActorId });
          sessions.push(input.actorId);
          return 3;
        },
        appPasswords,
        agentCredentials: credentials,
      },
    );

    expect(result).toEqual({
      actorId: targetActorId,
      orgId,
      disabled: true,
      sessionsRevoked: 3,
      appPasswordsRevoked: 2,
      agentCredentialsRevoked: 1,
    });
    expect(disabled).toEqual([targetActorId]);
    expect(sessions).toEqual([targetActorId]);
    expect(appPasswords.revokedIds).toEqual(["apw-1", "apw-2"]);
    expect(credentials.revokedClientIds).toEqual(["client-1"]);
    expect(appPasswords.records.find((r) => r.id === "apw-other")?.revokedAt).toBeNull();
    expect(credentials.records.find((r) => r.clientId === "client-other")?.revokedAt).toBeNull();
  });

  it("is idempotent when secrets are already revoked", async () => {
    const targetActorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const at = new Date("2026-08-03T13:00:00.000Z");
    const appPasswords = new RecordingAppPasswordStore([
      {
        id: "apw-already",
        orgId,
        actorId: targetActorId,
        revokedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const credentials = new RecordingAgentCredentialStore([
      {
        clientId: "client-already",
        orgId,
        actorId: targetActorId,
        revokedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const result = await offboardUser(
      { orgId, actorId: targetActorId, at },
      {
        resolveTargetInOrg: async () => true,
        disableActor: async () => false,
        revokeSessionsForActor: async () => 0,
        appPasswords,
        agentCredentials: credentials,
      },
    );

    expect(result).toEqual({
      actorId: targetActorId,
      orgId,
      disabled: false,
      sessionsRevoked: 0,
      appPasswordsRevoked: 0,
      agentCredentialsRevoked: 0,
    });
    expect(appPasswords.revokedIds).toEqual([]);
    expect(credentials.revokedClientIds).toEqual([]);
  });

  it("returns null without side effects when target is not in the admin org", async () => {
    const foreignActorId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let sessionsCalled = 0;
    let disableCalled = 0;
    const appPasswords = new RecordingAppPasswordStore([
      {
        id: "apw-foreign",
        orgId: "33333333-3333-4333-8333-333333333333",
        actorId: foreignActorId,
        revokedAt: null,
      },
    ]);
    const credentials = new RecordingAgentCredentialStore([
      {
        clientId: "client-foreign",
        orgId: "33333333-3333-4333-8333-333333333333",
        actorId: foreignActorId,
        revokedAt: null,
      },
    ]);

    const result = await offboardUser(
      { orgId, actorId: foreignActorId },
      {
        resolveTargetInOrg: async (input) => {
          expect(input.orgId).toBe(orgId);
          expect(input.actorId).toBe(foreignActorId);
          return false;
        },
        disableActor: async () => {
          disableCalled += 1;
          return true;
        },
        revokeSessionsForActor: async () => {
          sessionsCalled += 1;
          return 9;
        },
        appPasswords,
        agentCredentials: credentials,
      },
    );

    expect(result).toBeNull();
    expect(disableCalled).toBe(0);
    expect(sessionsCalled).toBe(0);
    expect(appPasswords.revokedIds).toEqual([]);
    expect(credentials.revokedClientIds).toEqual([]);
  });

  it("POST /api/admin/users/:actorId/offboard drives offboardUser cascade", async () => {
    const targetActorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const appPasswords = new RecordingAppPasswordStore([
      { id: "apw-route", orgId, actorId: targetActorId, revokedAt: null },
    ]);
    const credentials = new RecordingAgentCredentialStore([
      { clientId: "client-route", orgId, actorId: targetActorId, revokedAt: null },
    ]);
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async () => true,
        disableActor: async () => true,
        revokeSessionsForActor: async () => 2,
        appPasswords,
        agentCredentials: credentials,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetActorId}/offboard`,
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.users",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      offboard: {
        actorId: targetActorId,
        orgId,
        disabled: true,
        sessionsRevoked: 2,
        appPasswordsRevoked: 1,
        agentCredentialsRevoked: 1,
      },
    });
    expect(appPasswords.revokedIds).toEqual(["apw-route"]);
    expect(credentials.revokedClientIds).toEqual(["client-route"]);
    await app.close();
  });

  it("refuses self-offboard via the HTTP entry point", async () => {
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async () => true,
        revokeSessionsForActor: async () => 0,
        appPasswords: new RecordingAppPasswordStore([]),
        agentCredentials: new RecordingAgentCredentialStore([]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${actorId}/offboard`,
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.users",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Administrators cannot offboard themselves.",
    });
    await app.close();
  });

  it("POST offboard returns 404 for foreign org actor and does not revoke sessions", async () => {
    const foreignActorId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let sessionsCalled = 0;
    let resolveCalls = 0;
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async (input) => {
          resolveCalls += 1;
          expect(input).toEqual({ orgId, actorId: foreignActorId });
          return false;
        },
        disableActor: async () => {
          throw new Error("disableActor must not run for foreign target");
        },
        revokeSessionsForActor: async () => {
          sessionsCalled += 1;
          return 1;
        },
        appPasswords: new RecordingAppPasswordStore([]),
        agentCredentials: new RecordingAgentCredentialStore([]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${foreignActorId}/offboard`,
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.users",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "User not found in this organization.",
    });
    expect(resolveCalls).toBe(1);
    expect(sessionsCalled).toBe(0);
    await app.close();
  });

  it("POST offboard returns 404 for unknown actor id", async () => {
    const unknownActorId = "99999999-9999-4999-8999-999999999999";
    let sessionsCalled = 0;
    const app = fastify();
    await registerAdminUsersRoutes(app, {
      store: new FakeAdminUsersStore([]),
      actorFromRequest,
      offboardStores: {
        resolveTargetInOrg: async () => false,
        revokeSessionsForActor: async () => {
          sessionsCalled += 1;
          return 1;
        },
        appPasswords: new RecordingAppPasswordStore([]),
        agentCredentials: new RecordingAgentCredentialStore([]),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${unknownActorId}/offboard`,
      headers: {
        "x-helix-actor-id": actorId,
        "x-helix-org-id": orgId,
        "x-helix-scopes": "admin.users",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(sessionsCalled).toBe(0);
    await app.close();
  });
});

class FakeAdminUsersStore implements AdminUsersStore {
  readonly calls: ListAdminUsersInput[] = [];
  readonly creates: CreateAdminUserInput[] = [];
  readonly resets: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }[] = [];
  private nextCreateId = 0;

  constructor(
    private readonly users: readonly AdminUserRecord[],
    private readonly resetResult = false,
  ) {}

  async listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]> {
    this.calls.push(input);
    return this.users;
  }

  async findUserByEmail(input: {
    readonly orgId: string;
    readonly email: string;
  }): Promise<AdminUserRecord | null> {
    return (
      this.users.find(
        (user) => user.orgId === input.orgId && user.email?.toLowerCase() === input.email,
      ) ?? null
    );
  }

  async createUser(input: CreateAdminUserInput): Promise<AdminUserRecord> {
    this.creates.push(input);
    this.nextCreateId += 1;
    const now = "2026-09-10T00:00:00.000Z";
    return {
      id: `00000000-0000-4000-8000-${String(this.nextCreateId).padStart(12, "0")}`,
      orgId: input.orgId,
      type: "user",
      email: input.email,
      displayName: input.displayName,
      scopes: input.role === "admin" ? ["admin.*"] : ["mail.read"],
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async resetMfa(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }): Promise<boolean> {
    this.resets.push(input);
    return this.resetResult;
  }
}

type MutableAppPassword = {
  id: string;
  orgId: string;
  actorId: string;
  revokedAt: Date | null;
};

type MutableAgentCredential = {
  clientId: string;
  orgId: string;
  actorId: string;
  revokedAt: Date | null;
};

class RecordingAppPasswordStore implements OffboardAppPasswordStore {
  readonly revokedIds: string[] = [];
  readonly records: MutableAppPassword[];

  constructor(records: readonly MutableAppPassword[]) {
    this.records = records.map((record) => ({ ...record }));
  }

  async listAppPasswords(input: {
    readonly orgId: string;
    readonly actorId?: string;
    readonly includeRevoked?: boolean;
  }): Promise<readonly OffboardAppPasswordRecord[]> {
    return this.records
      .filter((record) => record.orgId === input.orgId)
      .filter((record) => input.actorId === undefined || record.actorId === input.actorId)
      .filter((record) => input.includeRevoked === true || record.revokedAt === null)
      .map(({ id, orgId: recordOrgId, revokedAt }) => ({ id, orgId: recordOrgId, revokedAt }));
  }

  async revokeAppPassword(input: {
    readonly id: string;
    readonly orgId: string;
    readonly revokedAt: Date;
  }): Promise<OffboardAppPasswordRecord | null> {
    const existing = this.records.find(
      (record) => record.id === input.id && record.orgId === input.orgId,
    );
    if (existing === undefined || existing.revokedAt !== null) {
      return null;
    }
    existing.revokedAt = input.revokedAt;
    this.revokedIds.push(input.id);
    return { id: existing.id, orgId: existing.orgId, revokedAt: existing.revokedAt };
  }
}

class RecordingAgentCredentialStore implements OffboardAgentCredentialStore {
  readonly revokedClientIds: string[] = [];
  readonly records: MutableAgentCredential[];

  constructor(records: readonly MutableAgentCredential[]) {
    this.records = records.map((record) => ({ ...record }));
  }

  async listClients(input: {
    readonly orgId: string;
    readonly actorId?: string;
    readonly includeRevoked?: boolean;
  }): Promise<readonly OffboardAgentCredentialRecord[]> {
    return this.records
      .filter((record) => record.orgId === input.orgId)
      .filter((record) => input.actorId === undefined || record.actorId === input.actorId)
      .filter((record) => input.includeRevoked === true || record.revokedAt === null);
  }

  async revokeClient(
    clientId: string,
    revokedAt: Date,
  ): Promise<OffboardAgentCredentialRecord | null> {
    const existing = this.records.find((record) => record.clientId === clientId);
    if (existing === undefined || existing.revokedAt !== null) {
      return null;
    }
    existing.revokedAt = revokedAt;
    this.revokedClientIds.push(clientId);
    return { ...existing };
  }
}

function userRecord(id: string, createdAt: string): AdminUserRecord {
  return {
    id,
    orgId,
    type: "user",
    email: "alice@example.com",
    displayName: "Alice",
    scopes: ["mail.read"],
    disabledAt: null,
    createdAt,
    updatedAt: createdAt,
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
  return { sql: tag as unknown as postgres.Sql, calls };
}
