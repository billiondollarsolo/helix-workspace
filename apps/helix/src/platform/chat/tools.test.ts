import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { createChatToolDefinitions, registerChatTools } from "./tools.js";
import type { ChatStore } from "./store.js";
import type {
  ChatMessageRecord,
  ChatPinRecord,
  ChatReactionRecord,
  ChatReadReceiptRecord,
  ChatRoomRecord,
  ChatSearchHit,
} from "./types.js";

const now = new Date("2026-05-20T12:00:00.000Z");
const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

describe("chat tools", () => {
  it("registers the Phase 3 chat tool surface", () => {
    const registry = createToolRegistry();
    registerChatTools(registry, { store: new FakeChatStore() });

    expect(registry.list().map((tool) => tool.id).sort()).toEqual([
      "chat.create_room",
      "chat.delete",
      "chat.edit",
      "chat.invite",
      "chat.member.remove",
      "chat.message.list",
      "chat.pin",
      "chat.pins.list",
      "chat.react",
      "chat.reply_in_thread",
      "chat.room.list",
      "chat.search",
      "chat.send",
      "chat.thread.list",
      "chat.unpin",
      "platform.ping",
    ]);
  });

  it("registers chat.reply_in_thread with chat.post", () => {
    const tool = createChatToolDefinitions({ store: new FakeChatStore() }).find(
      (t) => t.id === "chat.reply_in_thread",
    );
    expect(tool?.permission).toBe("chat.post");
  });

  it("registers chat.pin with chat.post", () => {
    const tool = createChatToolDefinitions({ store: new FakeChatStore() }).find(
      (t) => t.id === "chat.pin",
    );
    expect(tool?.permission).toBe("chat.post");
  });

  it("requires confirmation before removing a room member", () => {
    const tool = createChatToolDefinitions({ store: new FakeChatStore() }).find(
      (candidate) => candidate.id === "chat.member.remove",
    );
    expect(tool).toMatchObject({
      permission: "chat.create",
      sideEffects: "destructive",
      confirmationRequired: true,
    });
  });

  it("sends messages through the shared store contract", async () => {
    const store = new FakeChatStore();
    const registry = createToolRegistry();
    registerChatTools(registry, { store });

    const result = await registry.invoke(
      "chat.send",
      {
        roomId,
        body: "hello",
        attachmentObjectIds: ["55555555-5555-4555-8555-555555555555"],
      },
      {
        actor: {
          id: actorId,
          orgId,
          type: "user",
          scopes: ["chat.post"],
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(store.sent[0]).toMatchObject({
      orgId,
      actorId,
      roomId,
      body: "hello",
      attachmentObjectIds: ["55555555-5555-4555-8555-555555555555"],
    });
    expect(result.ok ? result.output : undefined).toMatchObject({
      id: messageId,
      roomId,
      body: "hello",
      sentAt: now.toISOString(),
    });
  });

  it("auto-classifies a newly sent message via the classifyResource hook", async () => {
    const store = new FakeChatStore();
    const registry = createToolRegistry();
    const classified: {
      resourceType: string;
      resourceId: string;
      content?: string;
      orgId: string;
    }[] = [];
    registerChatTools(registry, {
      store,
      classifyResource: async ({ actor, resourceType, resourceId, derivation }) => {
        classified.push({
          resourceType,
          resourceId,
          orgId: actor.orgId,
          ...(derivation.content === undefined ? {} : { content: derivation.content }),
        });
      },
    });

    const result = await registry.invoke(
      "chat.send",
      { roomId, body: "quarterly revenue figures" },
      {
        actor: { id: actorId, orgId, type: "user", scopes: ["chat.post"] },
      },
    );

    expect(result.ok).toBe(true);
    expect(classified).toEqual([
      {
        resourceType: "chat.message",
        resourceId: messageId,
        orgId,
        content: "quarterly revenue figures",
      },
    ]);
  });

  it("does not fail the send when classifyResource is not configured", async () => {
    const registry = createToolRegistry();
    registerChatTools(registry, { store: new FakeChatStore() });

    const result = await registry.invoke(
      "chat.send",
      { roomId, body: "hello" },
      { actor: { id: actorId, orgId, type: "user", scopes: ["chat.post"] } },
    );

    expect(result.ok).toBe(true);
  });

  it("normalizes search hits with ISO timestamps", async () => {
    const registry = createToolRegistry();
    registerChatTools(registry, { store: new FakeChatStore() });

    const result = await registry.invoke(
      "chat.search",
      { query: "hello" },
      {
        actor: {
          id: actorId,
          orgId,
          type: "user",
          scopes: ["chat.read"],
        },
      },
    );

    expect(result.ok ? result.output : undefined).toEqual({
      hits: [
        {
          roomId,
          messageId,
          actorId,
          subject: "General",
          preview: "hello",
          sentAt: now.toISOString(),
        },
      ],
    });
  });

  it("lists rooms and messages with read-safe tools", async () => {
    const registry = createToolRegistry();
    registerChatTools(registry, { store: new FakeChatStore() });
    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      scopes: ["chat.read"],
    };

    await expect(
      registry.invoke("chat.room.list", { query: "General" }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        rooms: [
          {
            id: roomId,
            subject: "General",
            members: [
              {
                actorId,
                role: "owner",
                displayName: "Maya Chen",
                email: "maya@example.com",
              },
            ],
            updatedAt: now.toISOString(),
          },
        ],
      },
    });
    await expect(
      registry.invoke("chat.message.list", { roomId, limit: 20 }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        messages: [{ id: messageId, roomId, body: "hello", sentAt: now.toISOString() }],
      },
    });
  });
});

class FakeChatStore implements ChatStore {
  readonly sent: unknown[] = [];

  async createRoom(): Promise<ChatRoomRecord> {
    return {
      id: roomId,
      orgId,
      kind: "chat_room",
      subject: "General",
      createdByActorId: actorId,
      metadata: {},
      members: [{ actorId, role: "owner", displayName: "Maya Chen", email: "maya@example.com" }],
      settings: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async invite(input: {
    readonly roomId: string;
    readonly actorIds: readonly string[];
  }): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }> {
    return { roomId: input.roomId, invitedActorIds: input.actorIds };
  }

  async listRooms(): Promise<readonly ChatRoomRecord[]> {
    return [await this.createRoom()];
  }

  async sendMessage(input: Parameters<ChatStore["sendMessage"]>[0]): Promise<ChatMessageRecord> {
    this.sent.push(input);
    return messageRecord(input.body);
  }

  async react(input: Parameters<ChatStore["react"]>[0]): Promise<ChatReactionRecord | null> {
    if (input.op === "remove") {
      return null;
    }
    return {
      messageId: input.messageId,
      actorId: input.actorId,
      orgId: input.orgId,
      emoji: input.emoji,
      createdAt: now,
    };
  }

  async editMessage(
    input: Parameters<ChatStore["editMessage"]>[0],
  ): Promise<ChatMessageRecord | null> {
    return messageRecord(input.body);
  }

  async deleteMessage(): Promise<ChatMessageRecord | null> {
    return { ...messageRecord("hello"), deletedAt: now };
  }

  async markRead(input: Parameters<ChatStore["markRead"]>[0]): Promise<ChatReadReceiptRecord> {
    return {
      roomId: input.roomId,
      actorId: input.actorId,
      orgId: input.orgId,
      lastReadMessageId: input.messageId ?? null,
      lastReadAt: now,
      updatedAt: now,
    };
  }

  async listMessages(): Promise<readonly ChatMessageRecord[]> {
    return [messageRecord("hello")];
  }

  async search(): Promise<readonly ChatSearchHit[]> {
    return [
      {
        roomId,
        messageId,
        actorId,
        subject: "General",
        preview: "hello",
        sentAt: now,
      },
    ];
  }

  async getRoomForActor(): Promise<ChatRoomRecord | null> {
    return this.createRoom();
  }

  async listThreadReplies(): Promise<readonly ChatMessageRecord[]> {
    return [messageRecord("reply")];
  }

  async pinMessage(input: {
    readonly roomId: string;
    readonly messageId: string;
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<ChatPinRecord> {
    return {
      roomId: input.roomId,
      messageId: input.messageId,
      orgId: input.orgId,
      pinnedByActorId: input.actorId,
      createdAt: now,
    };
  }

  async unpinMessage(): Promise<{ readonly ok: true }> {
    return { ok: true };
  }

  async listPins(): Promise<readonly ChatPinRecord[]> {
    return [];
  }
}

function messageRecord(body: string): ChatMessageRecord {
  return {
    id: messageId,
    orgId,
    roomId,
    actorId,
    body,
    bodyFormat: "plain",
    metadata: {},
    attachmentObjectIds: [],
    sentAt: now,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
