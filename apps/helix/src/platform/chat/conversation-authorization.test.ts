import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import { createChatToolDefinitions } from "./tools.js";
import type { ChatStore } from "./store.js";
import type { ChatRoomRecord } from "./types.js";
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "agent",
  scopes: ["chat.post"],
};
const roomId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
function fixture() {
  const room: ChatRoomRecord = {
    id: roomId,
    orgId: actor.orgId,
    kind: "chat_dm",
    subject: null,
    createdByActorId: actor.id,
    metadata: {},
    members: [{ actorId: actor.id, role: "member", displayName: "Atlas", email: null }],
    settings: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const getRoomForActor = vi.fn(async (): Promise<ChatRoomRecord | null> => room);
  const sendMessage = vi.fn(async () => ({
    id: messageId,
    orgId: actor.orgId,
    roomId,
    actorId: actor.id,
    body: "Hello",
    bodyFormat: "plain",
    metadata: {},
    attachmentObjectIds: [],
    sentAt: new Date(),
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const createRoom = vi.fn(async () => room);
  const store = { getRoomForActor, sendMessage, createRoom } as unknown as ChatStore;
  const registry = createToolRegistry({
    confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
  });
  for (const tool of createChatToolDefinitions({ store })) registry.register(tool);
  return { registry, getRoomForActor, sendMessage, createRoom, room };
}
describe("ordinary agent conversation authorization", () => {
  it("opens a direct conversation with chat.post while preserving room-creation scope separation", async () => {
    const f = fixture();
    const result = await f.registry.invoke(
      "chat.dm.open",
      { memberActorIds: [messageId] },
      {
        actor,
        credentialId: "credential",
        enforceConfirmation: true,
      },
    );
    expect(result).toMatchObject({ ok: true, output: { id: roomId } });
    expect(f.createRoom).toHaveBeenCalledWith({
      orgId: actor.orgId,
      actorId: actor.id,
      kind: "chat_dm",
      memberActorIds: [messageId],
      externalAccess: "internal",
    });
    expect(
      await f.registry.invoke(
        "chat.create_room",
        { memberActorIds: [messageId] },
        { actor, credentialId: "credential" },
      ),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(
      await f.registry.invoke(
        "chat.dm.open",
        { memberActorIds: [messageId] },
        { actor: { ...actor, scopes: ["chat.read"] }, credentialId: "credential" },
      ),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(f.createRoom).toHaveBeenCalledTimes(1);
  });
  it.each(["mcp", "assistant"] as const)(
    "sends normal room and thread replies immediately over %s",
    async (requestChannel) => {
      const f = fixture();
      for (const toolId of ["chat.send", "chat.reply_in_thread"]) {
        const result = await f.registry.invoke(
          toolId,
          { roomId, body: "Hello", parentMessageId: messageId },
          {
            actor,
            credentialId: "credential",
            enforceConfirmation: true,
            policyContext: {
              requestChannel,
              effectiveClassification: "standard",
              sourceIds: [],
              containsUntrustedContext: true,
            },
          },
        );
        expect(result).toMatchObject({ ok: true, output: { id: messageId } });
      }
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
      expect(f.getRoomForActor).toHaveBeenCalledWith({
        orgId: actor.orgId,
        actorId: actor.id,
        roomId,
      });
    },
  );
  it("honors explicit human approval even for a member's reply", async () => {
    const f = fixture();
    expect(
      await f.registry.invoke(
        "chat.send",
        { roomId, body: "Hello" },
        {
          actor,
          credentialId: "credential",
          credentialPolicy: { confirmationOverride: "always" },
        },
      ),
    ).toMatchObject({ ok: true, status: "pending_confirmation" });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["revoked-membership", "foreign-tenant", "attachment", "missing-scope"])(
    "does not auto-send with %s",
    async (reason) => {
      const f = fixture();
      if (reason === "revoked-membership") f.getRoomForActor.mockResolvedValue(null);
      if (reason === "foreign-tenant")
        f.getRoomForActor.mockResolvedValue({ ...f.room, orgId: "foreign" });
      const result = await f.registry.invoke(
        "chat.send",
        {
          roomId,
          body: "Hello",
          ...(reason === "attachment" ? { attachmentObjectIds: [messageId] } : {}),
        },
        {
          actor: reason === "missing-scope" ? { ...actor, scopes: [] } : actor,
          credentialId: "credential",
        },
      );
      expect(result.ok && result.status === "executed").toBe(false);
      expect(f.sendMessage).not.toHaveBeenCalled();
    },
  );
  it("does not grant member removal or deletion unattended authorization", () => {
    const f = fixture();
    for (const id of ["chat.member.remove", "chat.delete"]) {
      expect(f.registry.get(id)?.standingAuthorization).toBeUndefined();
    }
  });
});
