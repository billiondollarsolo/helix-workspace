import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresChatStore } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const roomId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-09-02T12:00:00.000Z");

describe("PostgresChatStore message idempotency", () => {
  it("returns the first message and emits no second outbox event on retry", async () => {
    const calls: string[] = [];
    let inserted = false;
    const tag = (strings: TemplateStringsArray) => {
      const query = strings.join("$");
      if (query.trimStart().startsWith("exists (")) {
        return { query };
      }
      calls.push(query);
      if (query.includes("from threads t")) return Promise.resolve([roomRow()]);
      if (query.includes("insert into messages")) {
        if (inserted) return Promise.resolve([]);
        inserted = true;
        return Promise.resolve([{ id: messageId }]);
      }
      if (query.includes("select id") && query.includes("client_message_id")) {
        return Promise.resolve([{ id: messageId }]);
      }
      if (query.includes("from messages m")) return Promise.resolve([messageRow()]);
      if (query.includes("from append_chat_room_event")) {
        return Promise.resolve([{ event_sequence: 7 }]);
      }
      if (query.includes("from chat_room_events")) return Promise.resolve([{ sequence: 7 }]);
      return Promise.resolve([]);
    };
    const sql = Object.assign(tag, {
      begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
        callback(sql as unknown as postgres.TransactionSql),
      array: (value: unknown) => value,
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql;
    const store = new PostgresChatStore(sql);
    const input = { orgId, actorId, roomId, body: "hello", clientMessageId: "device-42" };

    const first = await store.sendMessage(input);
    const retry = await store.sendMessage({ ...input, body: "ignored retry body" });

    expect(first.id).toBe(messageId);
    expect(retry).toEqual(first);
    expect(calls.filter((query) => query.includes("insert into outbox"))).toHaveLength(1);
    expect(calls.filter((query) => query.includes("from append_chat_room_event"))).toHaveLength(1);
    expect(calls.filter((query) => query.includes("update threads"))).toHaveLength(1);
    expect(calls.find((query) => query.includes("insert into messages"))).toContain(
      "on conflict (org_id, actor_id, thread_id, client_message_id)",
    );
  });
});

function roomRow() {
  return {
    id: roomId,
    org_id: orgId,
    kind: "chat_room",
    subject: "Room",
    created_by_actor_id: actorId,
    metadata: {},
    created_at: now,
    updated_at: now,
    settings_thread_id: null,
    settings_org_id: null,
    settings_name: null,
    settings_topic: null,
    settings_privacy: null,
    settings_metadata: null,
    settings_created_at: null,
    settings_updated_at: null,
    members: [{ actorId, role: "member", displayName: "Member", email: null }],
  };
}

function messageRow() {
  return {
    id: messageId,
    org_id: orgId,
    thread_id: roomId,
    actor_id: actorId,
    body: "hello",
    body_format: "plain",
    client_message_id: "device-42",
    metadata: {},
    attachment_object_ids: [],
    parent_message_id: null,
    sent_at: now,
    edited_at: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}
