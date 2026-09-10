import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { ChatRoomAccessError } from "./errors.js";
import { PostgresChatStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";

describe("Chat V2 negative-security boundary", () => {
  it("keeps non-member room list and search empty and blocks message reads and sends", async () => {
    const listSql = recordingSql([[]]);
    await expect(new PostgresChatStore(listSql.sql).listRooms({ orgId, actorId })).resolves.toEqual(
      [],
    );
    expect(listSql.calls[0]).toContain("exists");
    expect(listSql.calls[0]).toContain("chat_permission_is_valid");
    expect(listSql.calls[0]).toContain("t.org_id = ?");

    const searchSql = recordingSql([[]]);
    await expect(
      new PostgresChatStore(searchSql.sql).search({ orgId, actorId, query: "secret" }),
    ).resolves.toEqual([]);
    expect(searchSql.calls[0]).toContain("helix_chat_message_visible_to");
    expect(searchSql.calls[0]).toContain("m.org_id = ?");

    const readSql = recordingSql([[]]);
    await expect(
      new PostgresChatStore(readSql.sql).listMessages({ orgId, actorId, roomId }),
    ).rejects.toMatchObject({
      name: "ChatRoomAccessError",
      code: "not_found",
      message: "Chat room was not found.",
      details: undefined,
    });
    expect(readSql.calls.some((query) => query.includes("from messages"))).toBe(false);
    expect(readSql.calls[0]).toContain("t.org_id = ?");
    expect(readSql.calls[0]).toContain("chat_permission_is_valid(access_grant, ?, ?, t.id)");

    const sendSql = recordingSql([[]]);
    await expect(
      new PostgresChatStore(sendSql.sql).sendMessage({
        orgId,
        actorId,
        roomId,
        body: "must not be stored",
      }),
    ).rejects.toMatchObject({
      name: "ChatRoomAccessError",
      code: "not_found",
      message: "Chat room was not found.",
      details: undefined,
    });
    expect(sendSql.calls.some((query) => query.includes("insert into messages"))).toBe(false);
    expect(sendSql.calls[0]).toContain("t.org_id = ?");
    expect(sendSql.calls[0]).toContain("chat_permission_is_valid(access_grant, ?, ?, t.id)");
  });

  it("uses the same non-enumerable denial for listMessages and sendMessage when membership is missing", async () => {
    // E5.1 residual: store APIs must fail closed before history or insert side-effects.
    const listSql = recordingSql([[]]);
    const sendSql = recordingSql([[]]);
    const listRejection = new PostgresChatStore(listSql.sql).listMessages({
      orgId,
      actorId,
      roomId,
    });
    const sendRejection = new PostgresChatStore(sendSql.sql).sendMessage({
      orgId,
      actorId,
      roomId,
      body: "cross-check denial shape",
    });

    await expect(listRejection).rejects.toBeInstanceOf(ChatRoomAccessError);
    await expect(sendRejection).rejects.toBeInstanceOf(ChatRoomAccessError);

    const listError = await listRejection.catch((error: unknown) => error);
    const sendError = await sendRejection.catch((error: unknown) => error);
    expect(listError).toMatchObject({
      code: "not_found",
      message: "Chat room was not found.",
      details: undefined,
    });
    expect(sendError).toMatchObject({
      code: "not_found",
      message: "Chat room was not found.",
      details: undefined,
    });
    expect(listSql.calls.some((query) => query.includes("from messages"))).toBe(false);
    expect(sendSql.calls.some((query) => query.includes("insert into messages"))).toBe(false);
  });
});
function recordingSql(responses: readonly unknown[]) {
  const recording = sharedRecordingSql(responses, "?");
  return {
    sql: recording.sql,
    get calls() {
      return recording.queries;
    },
    get values() {
      return recording.values;
    },
  };
}
