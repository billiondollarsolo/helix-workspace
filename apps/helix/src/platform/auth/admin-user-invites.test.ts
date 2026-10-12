import type { Actor, OutboxMessage } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import { signupOnboardingInviteEmailSubject } from "../signup/email-delivery.js";
import type { OrgRecord } from "../tenancy/orgs.js";
import type { TenantContext } from "../tenancy/context.js";
import {
  registerAdminUserInviteRoutes,
  type AcceptAdminUserInviteResult,
  type AdminInviteRole,
  type AdminUserInviteStore,
  type IssuedAdminUserInvite,
  type PendingAdminUserInvite,
} from "./admin-user-invites.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const targetId = "55555555-5555-4555-8555-555555555555";
const expiresAt = new Date("2026-10-19T12:00:00.000Z");

class FakeInviteStore implements AdminUserInviteStore {
  readonly invited: {
    actor: Actor;
    input: { email: string; displayName: string; role: AdminInviteRole };
  }[] = [];
  readonly resent: string[] = [];
  readonly revoked: string[] = [];
  readonly inspected: { orgId: string; token: string }[] = [];
  readonly accepted: { orgId: string; token: string; passwordHash: string }[] = [];
  pending = new Set<string>([targetId]);
  inspection: PendingAdminUserInvite | null = {
    email: "ada@example.com",
    displayName: "Ada",
    expiresAt,
  };
  acceptResult: AcceptAdminUserInviteResult = {
    status: "accepted",
    actorId: targetId,
    email: "ada@example.com",
  };

  async invite(
    actor: Actor,
    input: { readonly email: string; readonly displayName: string; readonly role: AdminInviteRole },
  ): Promise<IssuedAdminUserInvite> {
    this.invited.push({ actor, input: { ...input } });
    return {
      actorId: targetId,
      email: input.email,
      displayName: input.displayName,
      token: "secret token/+",
      expiresAt,
    };
  }

  async resend(_actor: Actor, target: string): Promise<IssuedAdminUserInvite | null> {
    this.resent.push(target);
    if (!this.pending.has(target)) return null;
    return {
      actorId: target,
      email: "ada@example.com",
      displayName: "Ada",
      token: "fresh-token",
      expiresAt,
    };
  }

  async revoke(_actor: Actor, target: string): Promise<boolean> {
    this.revoked.push(target);
    return this.pending.delete(target);
  }

  async inspect(org: string, token: string): Promise<PendingAdminUserInvite | null> {
    this.inspected.push({ orgId: org, token });
    return this.inspection;
  }

  async accept(
    org: string,
    input: { readonly token: string; readonly passwordHash: string },
  ): Promise<AcceptAdminUserInviteResult> {
    this.accepted.push({ orgId: org, ...input });
    return this.acceptResult;
  }
}

const org = {
  id: orgId,
  slug: "acme",
  displayName: "Acme Corp",
} as OrgRecord;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(options: { readonly tenant?: boolean } = {}) {
  const store = new FakeInviteStore();
  const outbox: OutboxMessage[] = [];
  app = fastify();
  app.decorateRequest("tenant", null);
  if (options.tenant !== false) {
    app.addHook("preHandler", async (request) => {
      request.tenant = { orgId, orgSlug: "acme", org } as TenantContext;
    });
  }
  await registerAdminUserInviteRoutes(app, {
    store,
    orgs: { findById: async (id) => (id === orgId ? org : null) },
    outbox: {
      insert: async (message) => {
        outbox.push(message);
        return `outbox-${String(outbox.length)}`;
      },
    },
    publicBaseUrl: "https://helix.example",
    actorFromRequest,
    hashPassword: async (password) => `hashed:${password}`,
  });
  return { app, store, outbox };
}

const as = (scopes: string) => ({
  "x-helix-actor-id": actorId,
  "x-helix-org-id": orgId,
  "x-helix-scopes": scopes,
});

describe("admin user invitation routes", () => {
  it("refuses people without user administration", async () => {
    const { app, store, outbox } = await setup();
    for (const [method, url] of [
      ["POST", "/api/admin/users/invite"],
      ["POST", `/api/admin/users/${targetId}/invite/resend`],
      ["POST", `/api/admin/users/${targetId}/invite/revoke`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: as("admin.security mail.read"),
        payload: { email: "ada@example.com", role: "member" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ requiredScope: "admin.users" });
    }
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/admin/users/invite",
      payload: { email: "ada@example.com" },
    });
    expect(anonymous.statusCode).toBe(403);
    expect(store.invited).toEqual([]);
    expect(store.resent).toEqual([]);
    expect(store.revoked).toEqual([]);
    expect(outbox).toEqual([]);
  });

  it("invites a member and queues the admin invitation email", async () => {
    const { app, store, outbox } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/invite",
      headers: as("admin.users"),
      payload: { email: "  Ada@Example.com ", role: "member" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      actorId: targetId,
      email: "ada@example.com",
      // Without a name, the address's local part stands in.
      displayName: "ada",
      status: "invited",
      expiresAt: expiresAt.toISOString(),
    });
    expect(store.invited).toEqual([
      {
        actor: expect.objectContaining({ id: actorId, orgId }),
        input: { email: "ada@example.com", displayName: "ada", role: "member" },
      },
    ]);
    expect(outbox).toEqual([
      {
        subject: signupOnboardingInviteEmailSubject,
        payload: {
          orgId,
          orgSlug: "acme",
          workspaceName: "Acme Corp",
          actorId,
          email: "ada@example.com",
          inviteUrl: "https://helix.example/signup/invite?token=secret+token%2F%2B",
          source: "admin",
          deliveryKey: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          ),
        },
      },
    ]);
    const inviteUrl = new URL((outbox[0]?.payload as { inviteUrl: string }).inviteUrl);
    expect(inviteUrl.searchParams.get("token")).toBe("secret token/+");
  });

  it("defaults the role to member and keeps a given display name", async () => {
    const { app, store } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users/invite",
      headers: as("admin.users"),
      payload: { email: "ada@example.com", displayName: "  Ada Lovelace " },
    });
    expect(response.statusCode).toBe(201);
    expect(store.invited[0]?.input).toEqual({
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      role: "member",
    });
  });

  it("lets only a full administrator invite another administrator", async () => {
    const { app, store, outbox } = await setup();
    const scoped = await app.inject({
      method: "POST",
      url: "/api/admin/users/invite",
      headers: as("admin.users"),
      payload: { email: "ada@example.com", role: "admin" },
    });
    expect(scoped.statusCode).toBe(403);
    expect(scoped.json()).toMatchObject({ requiredScope: "admin.*" });
    expect(store.invited).toEqual([]);
    expect(outbox).toEqual([]);

    for (const scopes of ["admin.*", "*"]) {
      const full = await app.inject({
        method: "POST",
        url: "/api/admin/users/invite",
        headers: as(scopes),
        payload: { email: "ada@example.com", role: "admin" },
      });
      expect(full.statusCode).toBe(201);
    }
    expect(store.invited.map((call) => call.input.role)).toEqual(["admin", "admin"]);
  });

  it("rejects malformed invitations before touching the store", async () => {
    const { app, store } = await setup();
    for (const payload of [
      { email: "not-an-email" },
      { email: "ada@example.com", role: "owner" },
      { email: "ada@example.com", extra: true },
      { email: "ada@example.com", displayName: "x".repeat(201) },
      {},
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/users/invite",
        headers: as("admin.users"),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Enter a valid email address to invite." });
    }
    expect(store.invited).toEqual([]);
  });

  it("resends a pending invitation with a new link and 404s when there is none", async () => {
    const { app, store, outbox } = await setup();
    const resent = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/invite/resend`,
      headers: as("admin.users"),
    });
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toMatchObject({ actorId: targetId, status: "invited" });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toMatchObject({
      source: "admin",
      inviteUrl: "https://helix.example/signup/invite?token=fresh-token",
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/users/66666666-6666-4666-8666-666666666666/invite/resend",
      headers: as("admin.users"),
    });
    expect(missing.statusCode).toBe(404);
    expect(outbox).toHaveLength(1);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/users/not-a-uuid/invite/resend",
      headers: as("admin.users"),
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.resent).toEqual([targetId, "66666666-6666-4666-8666-666666666666"]);
  });

  it("gives each sent invitation its own delivery key", async () => {
    const { app, outbox } = await setup();
    for (let index = 0; index < 2; index += 1) {
      await app.inject({
        method: "POST",
        url: `/api/admin/users/${targetId}/invite/resend`,
        headers: as("admin.users"),
      });
    }
    const keys = outbox.map((message) => (message.payload as { deliveryKey: string }).deliveryKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("withdraws a pending invitation", async () => {
    const { app, store } = await setup();
    const revoked = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/invite/revoke`,
      headers: as("admin.users"),
    });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.body).toBe("");

    const again = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/invite/revoke`,
      headers: as("admin.users"),
    });
    expect(again.statusCode).toBe(404);
    expect(store.revoked).toEqual([targetId, targetId]);
  });

  it("previews an invitation in the request's workspace without signing in", async () => {
    const { app, store } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/invites/inspect",
      payload: { token: "invite-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email: "ada@example.com",
      displayName: "Ada",
      workspaceName: "Acme Corp",
      expiresAt: expiresAt.toISOString(),
      passwordMinLength: 8,
    });
    expect(store.inspected).toEqual([{ orgId, token: "invite-token" }]);

    store.inspection = null;
    const unknown = await app.inject({
      method: "POST",
      url: "/api/invites/inspect",
      payload: { token: "invite-token" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "invite_invalid" });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/invites/inspect",
      payload: { token: "" },
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toMatchObject({ code: "invite_invalid" });
  });

  it("treats every link as invalid when the request has no workspace", async () => {
    const { app, store } = await setup({ tenant: false });
    const inspect = await app.inject({
      method: "POST",
      url: "/api/invites/inspect",
      payload: { token: "invite-token" },
    });
    expect(inspect.statusCode).toBe(404);
    expect(inspect.json()).toMatchObject({ code: "invite_invalid" });
    const accept = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { token: "invite-token", password: "long enough password" },
    });
    expect(accept.statusCode).toBe(404);
    expect(accept.json()).toMatchObject({ code: "invite_invalid" });
    expect(store.inspected).toEqual([]);
    expect(store.accepted).toEqual([]);
  });

  it("accepts with a hashed password", async () => {
    const { app, store } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { token: "invite-token", password: "long enough password" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "accepted",
      actorId: targetId,
      email: "ada@example.com",
    });
    expect(store.accepted).toEqual([
      { orgId, token: "invite-token", passwordHash: "hashed:long enough password" },
    ]);
  });

  it("rejects passwords outside Better Auth's bounds", async () => {
    const { app, store } = await setup();
    for (const password of ["short", "x".repeat(129)]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/invites/accept",
        payload: { token: "invite-token", password },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Choose a password between 8 and 128 characters.",
      });
    }
    expect(store.accepted).toEqual([]);
  });

  it("maps invalid links and existing sign-ins to actionable errors", async () => {
    const { app, store } = await setup();
    store.acceptResult = { status: "invalid" };
    const invalid = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { token: "used-token", password: "long enough password" },
    });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json()).toMatchObject({ code: "invite_invalid" });

    store.acceptResult = { status: "existing_sign_in", email: "ada@example.com" };
    const existing = await app.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { token: "invite-token", password: "long enough password" },
    });
    expect(existing.statusCode).toBe(409);
    expect(existing.json()).toEqual({
      code: "existing_sign_in",
      error:
        "ada@example.com already has a Helix sign-in. Sign in with your existing password to join.",
    });
  });
});
