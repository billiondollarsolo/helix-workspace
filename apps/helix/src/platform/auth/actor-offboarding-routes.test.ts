import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "../../api/api-error.js";
import type { ActorOffboardingPreview, ActorOffboardingResult } from "./actor-offboarding.js";
import { registerAdminUsersRoutes } from "./admin-users.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "user",
  scopes: ["admin.users"],
};
const targetId = "33333333-3333-4333-8333-333333333333";
const successorActorId = "44444444-4444-4444-8444-444444444444";
const confirmationToken = "a".repeat(32);
const counts = {
  driveFiles: 1,
  driveFolders: 1,
  mailMessages: 2,
  mailDrafts: 1,
  calendars: 1,
  contacts: 1,
  addressBooks: 1,
  assistantConversations: 1,
  assistantMemories: 1,
};
const preview: ActorOffboardingPreview = {
  source: { id: targetId, type: "agent", displayName: "Source agent", email: null },
  successor: {
    id: successorActorId,
    type: "user",
    displayName: "Recipient",
    email: "recipient@example.test",
  },
  counts,
  receivingAddresses: [],
  preserveReceivingAddresses: false,
  blockers: [],
  confirmationToken,
};
const result: ActorOffboardingResult = {
  actorId: targetId,
  orgId,
  disabled: true,
  sessionsRevoked: 0,
  appPasswordsRevoked: 1,
  agentCredentialsRevoked: 2,
  successorActorId,
  counts,
  preserveReceivingAddresses: false,
  searchReindexJobId: "55555555-5555-4555-8555-555555555555",
};
const apps: ReturnType<typeof fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});
async function setup(principal = actor) {
  const app = fastify();
  apps.push(app);
  const store = {
    preview: vi.fn().mockResolvedValue(preview),
    offboard: vi.fn().mockResolvedValue(result),
  };
  await registerAdminUsersRoutes(app, {
    store: { listUsers: async () => [], resetMfa: async () => false },
    actorFromRequest: () => principal,
    offboarding: store,
  });
  return { app, store };
}

describe("reviewed account handoff HTTP boundary", () => {
  it("returns the authoritative direct preview and retains the offboard result envelope for agents", async () => {
    const { app, store } = await setup();
    const review = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/offboard/preview`,
      payload: { successorActorId },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toEqual(preview);
    expect(store.preview).toHaveBeenCalledWith(actor, {
      actorId: targetId,
      successorActorId,
      preserveReceivingAddresses: false,
    });
    const execute = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/offboard`,
      payload: { successorActorId, confirmationToken },
    });
    expect(execute.statusCode).toBe(200);
    expect(execute.json()).toEqual({ offboard: result });
    expect(store.offboard).toHaveBeenCalledWith(actor, {
      actorId: targetId,
      successorActorId,
      preserveReceivingAddresses: false,
      confirmationToken,
    });
  });

  it.each([
    { scopes: ["mail.read"] },
    { scopes: ["admin.console.read"] },
    {
      scopes: ["admin.*"],
      roleBindings: [
        { roleId: "deny", allow: [], deny: ["admin.users"], scope: { type: "org" as const } },
      ],
    },
  ])("requires current account administration for both endpoints %j", async (permissions) => {
    const { app, store } = await setup({ ...actor, ...permissions });
    for (const path of ["offboard/preview", "offboard"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/users/${targetId}/${path}`,
        payload: { successorActorId, confirmationToken },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(store.preview).not.toHaveBeenCalled();
    expect(store.offboard).not.toHaveBeenCalled();
  });
  it("allows an account administrator through the existing console.write permission", async () => {
    const { app } = await setup({ ...actor, scopes: ["admin.console.write"] });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${targetId}/offboard/preview`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects forged tenant/operator fields, missing review, malformed IDs and self execution before storage", async () => {
    const { app, store } = await setup();
    for (const payload of [
      { successorActorId },
      { successorActorId, confirmationToken, orgId },
      { successorActorId: "bad", confirmationToken },
      { successorActorId, confirmationToken, archiveWithoutSuccessor: true },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/users/${targetId}/offboard`,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${actor.id}/offboard`,
          payload: { successorActorId, confirmationToken },
        })
      ).statusCode,
    ).toBe(400);
    expect(store.offboard).not.toHaveBeenCalled();
  });

  it("preserves explicit receive-only choice and surfaces stale or foreign targets without retries", async () => {
    const { app, store } = await setup();
    store.offboard.mockRejectedValueOnce(new ConflictError("Review the changed handoff again."));
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${targetId}/offboard`,
      payload: { successorActorId, confirmationToken, preserveReceivingAddresses: true },
    });
    expect(response.statusCode).toBe(409);
    expect(store.offboard).toHaveBeenCalledTimes(1);
    expect(store.offboard).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ preserveReceivingAddresses: true }),
    );
    store.preview.mockRejectedValueOnce(new NotFoundError("Account not found in this workspace."));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/users/${targetId}/offboard/preview`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
