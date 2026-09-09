import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { ChatMessageNotFoundError } from "./errors.js";
import { PostgresChatStore } from "./store.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const olderMessageId = "44444444-4444-4444-8444-444444444444";
const newerMessageId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-02T12:00:00.000Z");

describe("PostgresChatStore read receipts", () => {
  it("scopes the candidate to one active member, organization, room, and live chat message", async () => {
    const recording = recordingSql({ markRows: [receiptRow(newerMessageId, true)] });
    const receipt = await new PostgresChatStore(recording.sql).markRead({
      orgId,
      actorId,
      roomId,
      messageId: newerMessageId,
    });

    expect(receipt.lastReadMessageId).toBe(newerMessageId);
    const query = markQuery(recording.calls);
    expect(query).toContain("message.org_id = $");
    expect(query).toContain("message.thread_id = $");
    expect(query).toContain("message.kind = 'chat'");
    expect(query).toContain("message.deleted_at is null");
    expect(query).toContain("chat_permission_is_valid(");
  });

  it("fails closed for a foreign, cross-room, deleted, or otherwise invalid message id", async () => {
    const recording = recordingSql({ markRows: [] });

    await expect(
      new PostgresChatStore(recording.sql).markRead({
        orgId,
        actorId,
        roomId,
        messageId: olderMessageId,
      }),
    ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });

  it("advances only to a greater database-assigned room sequence in one atomic upsert", async () => {
    const recording = recordingSql({ markRows: [receiptRow(newerMessageId, true)] });
    await new PostgresChatStore(recording.sql).markRead({
      orgId,
      actorId,
      roomId,
      messageId: olderMessageId,
    });

    const query = markQuery(recording.calls);
    expect(query).toContain("on conflict (thread_id, actor_id) do update");
    expect(query).toContain("excluded.last_read_sequence > chat_read_receipts.last_read_sequence");
    expect(query).toContain("last_read_at = excluded.last_read_at");
    expect(query).toContain("where not exists (select 1 from upserted)");
    expect(query).toContain("from append_chat_room_event(");
    expect(query).toContain("case when resolved.advanced and resolved.is_shared");
  });

  it("returns the stored high-water mark when a stale device loses the conflict", async () => {
    const recording = recordingSql({ markRows: [receiptRow(newerMessageId, true, null)] });

    await expect(
      new PostgresChatStore(recording.sql).markRead({
        orgId,
        actorId,
        roomId,
        messageId: olderMessageId,
      }),
    ).resolves.toMatchObject({ lastReadMessageId: newerMessageId, realtimeCursor: null });
  });

  it("keeps disabled receipts private and excludes departed or disabled members", async () => {
    const recording = recordingSql({
      listRows: [receiptRow(olderMessageId, false)],
      markRows: [receiptRow(olderMessageId, false)],
    });
    const store = new PostgresChatStore(recording.sql);

    await expect(
      store.markRead({ orgId, actorId, roomId, messageId: olderMessageId }),
    ).resolves.toMatchObject({ isShared: false });
    await store.listReadReceipts({ orgId, actorId, roomId });

    const query = recording.calls.find((call) => call.includes("from chat_read_receipts receipt"));
    if (query === undefined) throw new Error("Expected read-receipt list query.");
    expect(query).toContain("coalesce(settings.read_receipts_enabled, true)");
    expect(query).toContain("or receipt.actor_id = $");
    expect(query.match(/chat_permission_is_valid\(/g)).toHaveLength(2);
  });
});

function markQuery(calls: readonly string[]): string {
  const query = calls.find((call) => call.includes("with candidate as materialized"));
  if (query === undefined) throw new Error("Expected mark-read query.");
  return query;
}

function recordingSql(options: {
  readonly markRows: readonly Record<string, unknown>[];
  readonly listRows?: readonly Record<string, unknown>[];
}): { readonly sql: postgres.Sql; readonly calls: string[] } {
  const calls: string[] = [];
  const tag = (strings: TemplateStringsArray) => {
    const query = strings.join("$");
    if (query.trimStart().startsWith("exists (")) return { query };
    calls.push(query);
    if (query.includes("from threads t")) return Promise.resolve([roomRow()]);
    if (query.includes("with candidate as materialized")) {
      return Promise.resolve(options.markRows);
    }
    if (query.includes("from chat_read_receipts receipt")) {
      return Promise.resolve(options.listRows ?? []);
    }
    return Promise.resolve([]);
  };
  return { sql: tag as unknown as postgres.Sql, calls };
}

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
    settings_thread_id: roomId,
    settings_org_id: orgId,
    settings_name: "Room",
    settings_topic: null,
    settings_privacy: "restricted",
    settings_read_receipts_enabled: true,
    settings_metadata: {},
    settings_created_at: now,
    settings_updated_at: now,
    members: [],
  };
}

function receiptRow(messageId: string, isShared: boolean, realtimeCursor: number | null = 7) {
  return {
    thread_id: roomId,
    actor_id: actorId,
    org_id: orgId,
    last_read_message_id: messageId,
    last_read_sequence: messageId === newerMessageId ? 2 : 1,
    last_read_at: now,
    updated_at: now,
    is_shared: isShared,
    realtime_cursor: realtimeCursor,
  };
}
