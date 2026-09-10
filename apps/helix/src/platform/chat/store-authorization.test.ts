import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { ChatMemberAccessError, ChatRoomAccessError } from "./errors.js";
import { PostgresChatStore } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const roomId = "33333333-3333-4333-8333-333333333333";
const inviteeId = "44444444-4444-4444-8444-444444444444";

describe("Postgres chat authorization", () => {
  it("denies invitation by an ordinary member before writing", async () => {
    const recording = recordingSql([[roomRow("member")]]);
    const store = new PostgresChatStore(recording.sql);

    await expect(
      store.invite({ orgId, actorId, roomId, actorIds: [inviteeId], role: "member" }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]).toContain("chat_permission_is_valid");
  });

  it("rejects cross-tenant or disabled invitees as one opaque error", async () => {
    const recording = recordingSql([[roomRow("owner")], []]);
    const store = new PostgresChatStore(recording.sql);

    await expect(
      store.invite({ orgId, actorId, roomId, actorIds: [inviteeId], role: "moderator" }),
    ).rejects.toBeInstanceOf(ChatMemberAccessError);
    expect(recording.calls).toHaveLength(2);
  });

  it.each([
    ["member", "member"],
    ["moderator", "moderator"],
    ["owner", "owner"],
  ] as const)("denies %s removing %s", async (callerRole, targetRole) => {
    const row = roomRow(callerRole);
    row.members.push({ actorId: inviteeId, role: targetRole, displayName: "Target", email: null });
    const recording = recordingSql([[], [row]]);
    await expect(
      new PostgresChatStore(recording.sql).removeMember({
        orgId,
        actorId,
        roomId,
        removedActorId: inviteeId,
      }),
    ).rejects.toBeInstanceOf(ChatMemberAccessError);
    expect(recording.calls.some((query) => query.includes("delete from permissions"))).toBe(false);
  });

  it("locks membership before removing an ordinary member and appends an audit", async () => {
    const row = roomRow("owner");
    row.members.push({ actorId: inviteeId, role: "member", displayName: "Target", email: null });
    const recording = recordingSql([[], [row]]);
    await expect(
      new PostgresChatStore(recording.sql).removeMember({
        orgId,
        actorId,
        roomId,
        removedActorId: inviteeId,
      }),
    ).resolves.toEqual({ roomId, removedActorId: inviteeId, removed: true });
    expect(recording.calls[0]).toContain("for update");
    expect(recording.calls.some((query) => query.includes("delete from permissions"))).toBe(true);
    expect(recording.calls.some((query) => query.includes("insert into activity"))).toBe(true);
  });

  it("uses the same history and retention predicate for listing and export", async () => {
    const recording = recordingSql([[roomRow("owner")], [], [roomRow("owner")], []]);
    const store = new PostgresChatStore(recording.sql);

    await expect(store.listMessages({ orgId, actorId, roomId })).resolves.toEqual([]);
    await expect(store.exportRoom({ orgId, actorId, roomId })).resolves.toMatchObject({
      room: { id: roomId },
      messages: [],
    });
    expect(
      recording.calls.filter((query) => query.includes("helix_chat_message_visible_to")),
    ).toHaveLength(2);
  });
});

function roomRow(role: "owner" | "moderator" | "member") {
  const now = new Date();
  return {
    id: roomId,
    org_id: orgId,
    kind: "chat_room",
    subject: "room",
    created_by_actor_id: actorId,
    metadata: {},
    created_at: now,
    updated_at: now,
    settings_thread_id: roomId,
    settings_org_id: orgId,
    settings_name: "room",
    settings_topic: null,
    settings_privacy: "restricted",
    settings_read_receipts_enabled: true,
    settings_metadata: {},
    settings_created_at: now,
    settings_updated_at: now,
    members: [{ actorId, role, displayName: "Actor", email: null }],
  };
}
function recordingSql(responses: readonly unknown[]) {
  const recording = sharedRecordingSql(responses, "$");
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
