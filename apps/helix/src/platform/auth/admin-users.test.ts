import fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  PostgresAdminUsersStore,
  decodeAdminUsersCursor,
  encodeAdminUsersCursor,
  offboardUser,
  registerAdminUsersRoutes,
  registerPeopleDirectoryRoutes,
  type AdminUserRecord,
  type AdminUsersStore,
  type ListAdminUsersInput,
  type OffboardAgentCredentialRecord,
  type OffboardAgentCredentialStore,
  type OffboardAppPasswordRecord,
  type OffboardAppPasswordStore,
} from "./admin-users.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

describe("admin users routes", () => {
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
});

class FakeAdminUsersStore implements AdminUsersStore {
  readonly calls: ListAdminUsersInput[] = [];

  constructor(private readonly users: readonly AdminUserRecord[]) {}

  async listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]> {
    this.calls.push(input);
    return this.users;
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
