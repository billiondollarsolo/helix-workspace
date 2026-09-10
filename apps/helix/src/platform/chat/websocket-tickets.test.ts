import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { sha256Hex } from "../crypto/index.js";
import {
  CHAT_WEBSOCKET_AUDIENCE,
  CHAT_WEBSOCKET_PATH,
  chatWebSocketTicketFromProtocols,
  PostgresChatWebSocketTicketStore,
} from "./websocket-tickets.js";

const now = new Date("2026-09-02T12:00:00.000Z");
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Ada",
  email: "ada@example.com",
  scopes: ["chat:read"],
};
const roomId = "33333333-3333-4333-8333-333333333333";

describe("PostgresChatWebSocketTicketStore", () => {
  it("issues a 30-second opaque credential while persisting only its digest", async () => {
    const recording = recordingSql([]);
    const store = new PostgresChatWebSocketTicketStore(recording.sql);

    const issued = await store.issue({
      actor,
      roomId,
      audience: CHAT_WEBSOCKET_AUDIENCE,
      path: CHAT_WEBSOCKET_PATH,
      now,
    });

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(30_000);
    expect(recording.calls[0]?.text).toContain("insert into chat_websocket_tickets");
    expect(recording.calls[0]?.values).toContain(sha256Hex(issued.ticket));
    expect(recording.calls[0]?.values).not.toContain(issued.ticket);
  });

  it("redeems with one atomic update bound to audience, path, expiry, and unused state", async () => {
    const recording = recordingSql([
      {
        room_id: roomId,
        id: actor.id,
        org_id: actor.orgId,
        type: actor.type,
        email: actor.email,
        display_name: actor.displayName,
        scopes: actor.scopes,
      },
    ]);
    const store = new PostgresChatWebSocketTicketStore(recording.sql);

    await expect(
      store.consume({
        orgId: actor.orgId,
        ticket: "t".repeat(43),
        audience: CHAT_WEBSOCKET_AUDIENCE,
        path: CHAT_WEBSOCKET_PATH,
        now,
      }),
    ).resolves.toEqual({ actor, roomId });

    const query = recording.calls.find((call) =>
      call.text.includes("update chat_websocket_tickets"),
    );
    expect(query?.text).toContain("update chat_websocket_tickets");
    expect(query?.text).toContain("consumed_at is null");
    expect(query?.text).toContain("expires_at >");
    expect(query?.values).toContain(sha256Hex("t".repeat(43)));
    expect(query?.values).not.toContain("t".repeat(43));
  });
});

describe("chat websocket ticket protocol", () => {
  const ticket = "t".repeat(43);

  it("extracts one ticket only alongside the supported audience protocol", () => {
    expect(chatWebSocketTicketFromProtocols(`helix.chat.v1, helix.ticket.${ticket}`)).toBe(ticket);
  });

  it("rejects missing, malformed, duplicate, and bearer credentials", () => {
    expect(chatWebSocketTicketFromProtocols(undefined)).toBeNull();
    expect(chatWebSocketTicketFromProtocols(`helix.ticket.${ticket}`)).toBeNull();
    expect(chatWebSocketTicketFromProtocols("helix.chat.v1, helix.ticket.short")).toBeNull();
    expect(
      chatWebSocketTicketFromProtocols(
        `helix.chat.v1, helix.ticket.${ticket}, helix.ticket.${"u".repeat(43)}`,
      ),
    ).toBeNull();
    expect(chatWebSocketTicketFromProtocols("helix-bearer, access-token")).toBeNull();
  });
});
const recordingSql = (rows: readonly unknown[]) => sharedRecordingSql(() => rows);
