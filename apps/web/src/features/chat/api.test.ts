import { describe, expect, it, vi } from "vitest";
import {
  chatAttachmentContentUrl,
  chatRealtimeUrl,
  createChatRealtimeClient,
  createChatRoom,
  deleteChatMessage,
  editChatMessage,
  issueChatWebSocketTicket,
  inviteToRoom,
  listChatMessages,
  listChatRooms,
  reactToChatMessage,
  searchChat,
  saveChatAttachmentToDrive,
  sendChatMessage,
  uploadChatAttachment,
} from "./api";

describe("chat API", () => {
  it("searches through the chat.search tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          hits: [
            {
              roomId: "33333333-3333-4333-8333-333333333333",
              messageId: "44444444-4444-4444-8444-444444444444",
              actorId: "11111111-1111-4111-8111-111111111111",
              subject: "General",
              preview: "hello",
              sentAt: "2026-05-20T12:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await expect(searchChat({ query: "hello" }, fetchImpl)).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/chat.search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hello", roomId: undefined, limit: 50 }),
    });
  });

  it("lists rooms and message history through backend chat tools", async () => {
    const room = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "chat_room" as const,
      subject: "General",
      createdByActorId: "11111111-1111-4111-8111-111111111111",
      members: [
        {
          actorId: "11111111-1111-4111-8111-111111111111",
          role: "owner",
          displayName: "Maya Chen",
          email: "maya@example.com",
        },
      ],
      settings: null,
      createdAt: "2026-05-20T11:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    };
    const message = {
      id: "44444444-4444-4444-8444-444444444444",
      roomId: room.id,
      actorId: "11111111-1111-4111-8111-111111111111",
      body: "hello",
      bodyFormat: "plain",
      attachmentObjectIds: [],
      sentAt: "2026-05-20T12:00:00.000Z",
      editedAt: null,
      deletedAt: null,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ rooms: [room] }))
      .mockResolvedValueOnce(Response.json({ messages: [message] }));

    await expect(listChatRooms({ query: "gen" }, fetchImpl)).resolves.toEqual([room]);
    await expect(listChatMessages({ roomId: room.id, limit: 25 }, fetchImpl)).resolves.toEqual([
      message,
    ]);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/chat.room.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "gen", limit: 50 }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/chat.message.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: room.id,
        before: undefined,
        direction: undefined,
        limit: 25,
      }),
    });
  });

  it("sends, edits, reacts, and deletes with backend tool payloads", async () => {
    const message = {
      id: "44444444-4444-4444-8444-444444444444",
      roomId: "33333333-3333-4333-8333-333333333333",
      actorId: "11111111-1111-4111-8111-111111111111",
      body: "hello",
      bodyFormat: "plain",
      attachmentObjectIds: [],
      sentAt: "2026-05-20T12:00:00.000Z",
      editedAt: null,
      deletedAt: null,
    };
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(message)));

    await expect(
      sendChatMessage(
        { roomId: message.roomId, body: "hello", attachmentObjectIds: [] },
        fetchImpl,
      ),
    ).resolves.toEqual(message);
    await expect(
      editChatMessage({ messageId: message.id, body: "updated" }, fetchImpl),
    ).resolves.toEqual(message);
    fetchImpl.mockResolvedValueOnce(Response.json({ reaction: null }));
    await expect(
      reactToChatMessage({ messageId: message.id, emoji: "✅", op: "remove" }, fetchImpl),
    ).resolves.toBeNull();
    fetchImpl.mockResolvedValueOnce(
      Response.json({ ...message, deletedAt: "2026-05-20T12:01:00.000Z" }),
    );
    await deleteChatMessage(message.id, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/chat.send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: message.roomId,
        body: "hello",
        bodyFormat: "plain",
        attachmentObjectIds: [],
        metadata: {},
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/chat.edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: message.id, body: "updated" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/chat.react", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: message.id, emoji: "✅", op: "remove" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(4, "/api/tools/chat.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: message.id }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing chat scope" }, { status: 403 })),
    );

    await expect(searchChat({}, fetchImpl)).rejects.toThrow("missing chat scope");
  });

  it("creates rooms and invites through backend tools", async () => {
    const room = {
      id: "33333333-3333-4333-8333-333333333333",
      orgId: "22222222-2222-4222-8222-222222222222",
      kind: "chat_dm" as const,
      subject: null,
      createdByActorId: "11111111-1111-4111-8111-111111111111",
      metadata: {},
      members: [],
      settings: null,
      createdAt: "2026-05-20T11:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(room))
      .mockResolvedValueOnce(
        Response.json({
          roomId: room.id,
          invitedActorIds: ["55555555-5555-4555-8555-555555555555"],
        }),
      );

    await expect(
      createChatRoom(
        {
          kind: "chat_dm",
          memberActorIds: ["55555555-5555-4555-8555-555555555555"],
        },
        fetchImpl,
      ),
    ).resolves.toEqual(room);
    await expect(
      inviteToRoom(
        {
          roomId: room.id,
          actorIds: ["55555555-5555-4555-8555-555555555555"],
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      roomId: room.id,
      invitedActorIds: ["55555555-5555-4555-8555-555555555555"],
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/chat.create_room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat_dm",
        memberActorIds: ["55555555-5555-4555-8555-555555555555"],
        privacy: "restricted",
        readReceiptsEnabled: true,
        spaceType: "conversation",
        historyPolicy: "full",
        retentionDays: null,
        legalHold: false,
        notificationPolicy: "all",
        externalAccess: "guests",
        metadata: {},
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/chat.invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: room.id,
        actorIds: ["55555555-5555-4555-8555-555555555555"],
        role: "member",
      }),
    });
  });

  it("builds chat WS URLs without access_token query params", () => {
    const url = chatRealtimeUrl("ws://localhost/ws/chat");
    expect(url).not.toContain("access_token");
  });

  it("mints a room-bound ticket over the authenticated HTTP channel", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ ticket: "t".repeat(43) })));

    await expect(
      issueChatWebSocketTicket("33333333-3333-4333-8333-333333333333", fetchImpl),
    ).resolves.toBe("t".repeat(43));
    expect(fetchImpl).toHaveBeenCalledWith("/api/chat/ws-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "33333333-3333-4333-8333-333333333333" }),
    });
  });

  it("uploads raw Chat images and exposes explicit content and Drive-promotion URLs", async () => {
    const objectId = "44444444-4444-4444-8444-444444444444";
    const file = new File(["GIF89a"], "animated.gif", { type: "image/gif" });
    const attachment = {
      objectId,
      source: "chat" as const,
      filename: file.name,
      mimeType: file.type,
      byteSize: file.size,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(attachment, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ objectId: "55555555-5555-4555-8555-555555555555" }, { status: 201 }),
      );

    await expect(
      uploadChatAttachment("33333333-3333-4333-8333-333333333333", file, fetchImpl),
    ).resolves.toEqual(attachment);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/chat/rooms/33333333-3333-4333-8333-333333333333/attachments?filename=animated.gif",
      { method: "POST", headers: { "content-type": "image/gif" }, body: file },
    );
    await expect(saveChatAttachmentToDrive(objectId, fetchImpl)).resolves.toEqual({
      objectId: "55555555-5555-4555-8555-555555555555",
    });
    expect(chatAttachmentContentUrl(objectId)).toBe(`/v1/api/chat/attachments/${objectId}/content`);
    expect(chatAttachmentContentUrl(objectId, true)).toBe(
      `/v1/api/chat/attachments/${objectId}/content?download=1`,
    );
  });

  it("serializes chat websocket messages and parses realtime events", () => {
    const events: unknown[] = [];
    const client = createChatRealtimeClient({
      ticket: "t".repeat(43),
      url: "ws://localhost/ws/chat",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent: (event) => events.push(event),
    });
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) {
      throw new Error("Expected websocket instance.");
    }
    expect(socket.url).toBe("ws://localhost/ws/chat");
    expect(socket.protocols).toEqual(["helix.chat.v1", `helix.ticket.${"t".repeat(43)}`]);

    client.subscribe("33333333-3333-4333-8333-333333333333", 7);
    client.setTyping("33333333-3333-4333-8333-333333333333", true);
    client.markRead("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444");
    client.requestPresence("33333333-3333-4333-8333-333333333333");
    client.sendMessage({
      roomId: "33333333-3333-4333-8333-333333333333",
      body: "hello",
      bodyFormat: "plain",
      attachmentObjectIds: [],
    });

    expect(socket.sent.map((payload) => JSON.parse(payload) as unknown)).toEqual([
      { type: "subscribe", roomId: "33333333-3333-4333-8333-333333333333", cursor: 7 },
      {
        type: "typing",
        roomId: "33333333-3333-4333-8333-333333333333",
        isTyping: true,
      },
      {
        type: "read",
        roomId: "33333333-3333-4333-8333-333333333333",
        messageId: "44444444-4444-4444-8444-444444444444",
      },
      { type: "presence", roomId: "33333333-3333-4333-8333-333333333333" },
      {
        type: "send",
        roomId: "33333333-3333-4333-8333-333333333333",
        body: "hello",
        bodyFormat: "plain",
        attachmentObjectIds: [],
      },
    ]);

    socket.receive({ type: "typing", roomId: "room", actorId: "sam", isTyping: true });
    expect(events).toEqual([{ type: "typing", roomId: "room", actorId: "sam", isTyping: true }]);
    client.close();
  });

  it("heartbeats an open chat socket until it closes", () => {
    vi.useFakeTimers();
    try {
      const client = createChatRealtimeClient({
        ticket: "h".repeat(43),
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => undefined,
      });
      const socket = FakeWebSocket.instances.at(-1);
      if (socket === undefined) throw new Error("Expected websocket instance.");
      socket.open();
      vi.advanceTimersByTime(15_000);
      expect(socket.sent.at(-1)).toBe('{"type":"heartbeat"}');
      client.close();
      vi.advanceTimersByTime(30_000);
      expect(socket.sent.filter((frame) => frame.includes("heartbeat"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { readonly data?: string }) => void>>();
  readyState = FakeWebSocket.OPEN;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void {
    const listeners =
      this.#listeners.get(type) ?? new Set<(event: { readonly data?: string }) => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  private emit(type: string, event: { readonly data?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
