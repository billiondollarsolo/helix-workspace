import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerProfileRoutes, type UserProfile } from "./profile.js";

const actor: Actor = {
  id: "b7200000-0000-4000-8000-000000000001",
  orgId: "b7200000-0000-4000-8000-000000000002",
  type: "user",
  scopes: [],
};
const profile: UserProfile = {
  actorId: actor.id,
  orgId: actor.orgId,
  email: "member@example.com",
  displayName: "Member",
  pronouns: "",
  jobTitle: "",
  about: "",
  avatarDataUrl: null,
};
const pngAvatar = `data:image/png;base64,${Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
]).toString("base64")}`;

async function fixture(principal: Actor | null = actor) {
  const app = fastify();
  const store = {
    get: vi.fn(async () => profile),
    update: vi.fn(async (_orgId: string, _actorId: string, patch: Partial<UserProfile>) => ({
      ...profile,
      ...patch,
    })),
  };
  const auditSink = { append: vi.fn(async () => ({ id: "audit", thisHash: "hash" })) };
  registerProfileRoutes(app, {
    store,
    auditSink,
    actorFromRequest: () => principal ?? { ...actor, id: "anonymous" },
    sessionActorResolver: { resolve: async () => principal },
  });
  return { app, store, auditSink };
}

describe("tenant user profiles", () => {
  it("saves and removes a validated avatar image and rejects other content", async () => {
    const { app, store } = await fixture();
    try {
      const saved = await app.inject({
        method: "PATCH",
        url: "/api/profile",
        payload: { avatarDataUrl: pngAvatar },
      });
      expect(saved.statusCode).toBe(200);
      expect(store.update).toHaveBeenLastCalledWith(actor.orgId, actor.id, {
        avatarDataUrl: pngAvatar,
      });
      const removed = await app.inject({
        method: "PATCH",
        url: "/api/profile",
        payload: { avatarDataUrl: null },
      });
      expect(removed.statusCode).toBe(200);
      expect(store.update).toHaveBeenLastCalledWith(actor.orgId, actor.id, { avatarDataUrl: null });

      for (const avatarDataUrl of [
        // Declared PNG but the bytes are a script.
        `data:image/png;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`,
        `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
        `${pngAvatar}${"A".repeat(350_000)}`,
      ]) {
        const rejected = await app.inject({
          method: "PATCH",
          url: "/api/profile",
          payload: { avatarDataUrl },
        });
        expect(rejected.statusCode).toBe(400);
      }
      expect(store.update).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("trims editable fields and audits changed field names without storing their contents in audit", async () => {
    const { app, store, auditSink } = await fixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/profile",
        payload: {
          displayName: "  Alex Example  ",
          pronouns: " they/them ",
          jobTitle: " Engineer ",
          about: " Line one\nLine two ",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().profile).toMatchObject({
        displayName: "Alex Example",
        pronouns: "they/them",
        jobTitle: "Engineer",
        about: "Line one\nLine two",
      });
      expect(store.update).toHaveBeenCalledWith(actor.orgId, actor.id, {
        displayName: "Alex Example",
        pronouns: "they/them",
        jobTitle: "Engineer",
        about: "Line one\nLine two",
      });
      expect(auditSink.append).toHaveBeenCalledWith({
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "user.profile.updated",
        objectType: "actor",
        objectId: actor.id,
        metadata: { fields: ["displayName", "pronouns", "jobTitle", "about"], self: true },
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {},
    { displayName: " " },
    { displayName: "a".repeat(201) },
    { displayName: "A\nB" },
    { pronouns: "p".repeat(81) },
    { jobTitle: "j".repeat(201) },
    { about: "a".repeat(2001) },
    { about: "bad\u0000text" },
    { displayName: "Name", email: "new@example.com" },
    { metadata: { scopes: ["admin.*"] } },
    { orgId: actor.orgId },
    { roles: ["owner"] },
    { actorId: actor.id },
  ])("rejects invalid or security-sensitive patch %j before storage", async (payload) => {
    const { app, store, auditSink } = await fixture();
    try {
      const response = await app.inject({ method: "PATCH", url: "/api/profile", payload });
      expect(response.statusCode).toBe(400);
      expect(store.update).not.toHaveBeenCalled();
      expect(auditSink.append).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires a browser session for self-service, even if an API principal exists", async () => {
    const app = fastify();
    const get = vi.fn(async () => profile);
    registerProfileRoutes(app, {
      store: { get, update: vi.fn() },
      sessionActorResolver: { resolve: async () => null },
      actorFromRequest: () => actor,
      auditSink: { append: vi.fn() },
    });
    try {
      expect((await app.inject("/api/profile")).statusCode).toBe(401);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { principal: actor, status: 403 },
    { principal: { ...actor, scopes: ["admin.console.read"] }, status: 403 },
    { principal: { ...actor, scopes: ["admin.users"] }, status: 200 },
    { principal: { ...actor, scopes: ["admin.console.write"] }, status: 200 },
    {
      principal: {
        ...actor,
        scopes: ["admin.*"],
        roleBindings: [
          { roleId: "denied", allow: [], deny: ["admin.users"], scope: { type: "org" as const } },
        ],
      },
      status: 403,
    },
  ])(
    "enforces admin write permission and explicit denies ($status)",
    async ({ principal, status }) => {
      const { app, store } = await fixture(principal);
      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/admin/users/${actor.id}/profile`,
          payload: { pronouns: "" },
        });
        expect(response.statusCode).toBe(status);
        expect(store.update).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      } finally {
        await app.close();
      }
    },
  );

  it("allows a read-only administrator to view details", async () => {
    const { app, store } = await fixture({ ...actor, scopes: ["admin.console.read"] });
    try {
      expect((await app.inject(`/api/admin/users/${actor.id}/profile`)).statusCode).toBe(200);
      expect(store.get).toHaveBeenCalledWith(actor.orgId, actor.id);
    } finally {
      await app.close();
    }
  });
});
