import { describe, expect, it } from "vitest";
import {
  chatCreateRoomInputSchema,
  chatImportInputSchema,
  CHAT_BODY_MAX_BYTES,
  CHAT_MAX_ATTACHMENTS,
  CHAT_METADATA_MAX_BYTES,
  chatInboundFrameSchema,
  chatExportInputSchema,
  chatOutboundFrameSchema,
  chatSendInputSchema,
} from "./chat.js";

describe("chat contracts", () => {
  it("parses known inbound frame types", () => {
    expect(
      chatInboundFrameSchema.parse({
        type: "subscribe",
        roomId: "11111111-1111-4111-8111-111111111111",
      }).type,
    ).toBe("subscribe");
    expect(
      chatInboundFrameSchema.parse({
        type: "send",
        roomId: "11111111-1111-4111-8111-111111111111",
        body: "hello",
      }).type,
    ).toBe("send");
    expect(
      chatInboundFrameSchema.parse({
        type: "presence.set",
        status: "away",
      }).type,
    ).toBe("presence.set");
  });

  it("rejects an unknown inbound frame type", () => {
    expect(() => chatInboundFrameSchema.parse({ type: "nope" })).toThrow();
  });

  it("requires an exact message for read progress and defaults receipt sharing on", () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    expect(() => chatInboundFrameSchema.parse({ type: "read", roomId })).toThrow();
    expect(chatCreateRoomInputSchema.parse({}).readReceiptsEnabled).toBe(true);
    expect(
      chatCreateRoomInputSchema.parse({ readReceiptsEnabled: false }).readReceiptsEnabled,
    ).toBe(false);
  });

  it("defaults governed rooms and validates portable imports", () => {
    expect(chatCreateRoomInputSchema.parse({})).toMatchObject({
      spaceType: "conversation",
      historyPolicy: "full",
      retentionDays: null,
      legalHold: false,
      notificationPolicy: "all",
      externalAccess: "guests",
    });
    expect(
      chatImportInputSchema.parse({
        roomId: "11111111-1111-4111-8111-111111111111",
        messages: [{ sourceMessageId: "legacy-1", body: "hello" }],
      }).messages[0],
    ).toMatchObject({ bodyFormat: "plain", metadata: {} });
  });

  it("enforces send body length bounds", () => {
    expect(() =>
      chatSendInputSchema.parse({
        roomId: "11111111-1111-4111-8111-111111111111",
        body: "",
      }),
    ).toThrow();
    expect(
      chatSendInputSchema.parse({
        roomId: "11111111-1111-4111-8111-111111111111",
        body: "ok",
      }).body,
    ).toBe("ok");
    expect(
      chatSendInputSchema.parse({
        roomId: "11111111-1111-4111-8111-111111111111",
        body: "",
        attachmentObjectIds: ["22222222-2222-4222-8222-222222222222"],
      }).attachmentObjectIds,
    ).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("enforces UTF-8, Unicode, format, metadata, and attachment bounds", () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    const objectId = "22222222-2222-4222-8222-222222222222";
    for (const unsafe of [
      { roomId, body: "é".repeat(CHAT_BODY_MAX_BYTES / 2 + 1) },
      { roomId, body: "bad \ud800 value" },
      { roomId, body: "ok", bodyFormat: "html" },
      { roomId, body: "ok", metadata: { value: "x".repeat(CHAT_METADATA_MAX_BYTES) } },
      {
        roomId,
        body: "ok",
        attachmentObjectIds: Array.from({ length: CHAT_MAX_ATTACHMENTS + 1 }, () => objectId),
      },
    ]) {
      expect(chatSendInputSchema.safeParse(unsafe).success).toBe(false);
    }
  });

  it("validates outbound message.created and error frames", () => {
    const created = chatOutboundFrameSchema.parse({
      type: "message.created",
      roomId: "11111111-1111-4111-8111-111111111111",
      cursor: 1,
      message: {
        id: "22222222-2222-4222-8222-222222222222",
        orgId: "33333333-3333-4333-8333-333333333333",
        roomId: "11111111-1111-4111-8111-111111111111",
        actorId: null,
        body: "hi",
        bodyFormat: "plain",
        metadata: {},
        attachmentObjectIds: [],
        sentAt: "2026-07-18T00:00:00.000Z",
        editedAt: null,
        deletedAt: null,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    });
    expect(created.type).toBe("message.created");

    expect(
      chatInboundFrameSchema.parse({
        type: "subscribe",
        roomId: "11111111-1111-4111-8111-111111111111",
        cursor: 42,
      }),
    ).toMatchObject({ cursor: 42 });

    const err = chatOutboundFrameSchema.parse({
      type: "error",
      code: "forbidden",
      message: "no access",
    });
    expect(err.type).toBe("error");
  });

  it("bounds organization exports and rejects inverted date ranges", () => {
    expect(
      chatExportInputSchema.safeParse({
        from: "2026-07-29T00:00:00.000Z",
        to: "2026-07-28T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(chatExportInputSchema.safeParse({ limit: 10001 }).success).toBe(false);
  });
});
