import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import {
  PostgresAdminUsersStore,
  canReadAdminUsers,
  decodeAdminUsersCursor,
  encodeAdminUsersCursor,
  registerAdminUsersRoutes,
  type AdminUserLifecycleResult,
  type AdminUserRecord,
  type AdminUsersStore,
  type ListAdminUsersInput,
} from "./admin-users.js";

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

  it("suspends and restores people for user administrators only", async () => {
    const targetId = "55555555-5555-4555-8555-555555555555";
    const store = new FakeAdminUsersStore([userRecord(targetId, "2026-05-20T12:05:00.000Z")]);
    const app = fastify();
    await registerAdminUsersRoutes(app, { store, actorFromRequest });
    const as = (scopes: string) => ({
      "x-helix-actor-id": actorId,
      "x-helix-org-id": orgId,
      "x-helix-scopes": scopes,
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/suspend`,
      headers: as("admin.security"),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ requiredScope: "admin.users" });
    expect(store.lifecycle).toEqual([]);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/users/not-a-uuid/suspend",
      headers: as("admin.users"),
    });
    expect(invalid.statusCode).toBe(400);

    const suspended = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/suspend`,
      headers: as("admin.users"),
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toEqual({ actorId: targetId, status: "suspended", changed: true });

    const restored = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/restore`,
      headers: as("admin.users"),
    });
    expect(restored.json()).toEqual({ actorId: targetId, status: "active", changed: true });
    expect(store.lifecycle).toEqual([
      { orgId, targetActorId: targetId, suspended: true },
      { orgId, targetActorId: targetId, suspended: false },
    ]);

    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/users/66666666-6666-4666-8666-666666666666/restore",
      headers: as("admin.users"),
    });
    expect(missing.statusCode).toBe(404);
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

describe("PostgresAdminUsersStore", () => {
  it("reads users from actors with org, query, type, disabled, and cursor filters", async () => {
    const disabledAt = new Date("2026-05-20T13:00:00.000Z");
    const createdAt = new Date("2026-05-20T12:00:00.000Z");
    const updatedAt = new Date("2026-05-20T12:30:00.000Z");
    const cursorCreatedAt = new Date("2026-05-20T14:00:00.000Z");
    const cursorId = "77777777-7777-4777-8777-777777777777";
    const recording = createRecordingSql(
      [
        [
          {
            id: actorId,
            org_id: orgId,
            type: "agent",
            email: "agent@example.com",
            display_name: "Agent One",
            scopes: ["mail.read"],
            disabled_at: disabledAt,
            membership_status: null,
            last_sign_in_at: null,
            created_at: createdAt,
            updated_at: updatedAt,
          },
        ],
      ],
      "$",
    );
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
        status: "removed",
        disabledAt: disabledAt.toISOString(),
        lastSignInAt: null,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
    expect(recording.calls[0]?.text).toContain("from actors actor");
    expect(recording.calls[0]?.text).toContain("left join organization_memberships membership");
    expect(recording.calls[0]?.text).toContain("where actor.org_id =");
    expect(recording.calls[0]?.text).toContain("actor.type =");
    expect(recording.calls[0]?.text).toContain("actor.disabled_at is null");
    expect(recording.calls[0]?.text).toContain("lower(coalesce(actor.email, ''))");
    expect(recording.calls[0]?.text).toContain("(actor.created_at, actor.id) <");
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

class FakeAdminUsersStore implements AdminUsersStore {
  readonly calls: ListAdminUsersInput[] = [];
  readonly resets: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }[] = [];
  readonly lifecycle: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly suspended: boolean;
  }[] = [];

  constructor(
    private readonly users: readonly AdminUserRecord[],
    private readonly resetResult = false,
  ) {}

  async listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]> {
    this.calls.push(input);
    return this.users;
  }

  async resetMfa(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }): Promise<boolean> {
    this.resets.push(input);
    return this.resetResult;
  }

  async setSuspended(
    actor: Actor,
    targetActorId: string,
    suspended: boolean,
  ): Promise<AdminUserLifecycleResult | null> {
    this.lifecycle.push({ orgId: actor.orgId, targetActorId, suspended });
    return this.users.some((user) => user.id === targetActorId)
      ? { actorId: targetActorId, status: suspended ? "suspended" : "active", changed: true }
      : null;
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
    status: "active",
    disabledAt: null,
    lastSignInAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}
