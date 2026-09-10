import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { PostgresMeetStore } from "./store.js";

const now = new Date("2026-05-20T12:00:00.000Z");
const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const roomId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const messageId = "55555555-5555-4555-8555-555555555555";
const objectId = "66666666-6666-4666-8666-666666666666";

describe("Postgres Meet store recording attachments", () => {
  it("creates recording object state, attaches it to the call thread, and grants participant object access", async () => {
    const recording = createRecordingSql([
      [],
      [roomRow()],
      [],
      [],
      [],
      [],
      [{ id: messageId }],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresMeetStore(recording.sql);

    const attachment = await store.attachRecording({
      orgId,
      actorId,
      roomId,
      storageKey: "recordings/launch-review.mp4",
      mimeType: "video/mp4",
      byteSize: 4096,
      sha256: "a".repeat(64),
      metadata: { source: "jibri" },
    });

    expect(attachment).toMatchObject({
      roomId,
      threadId,
      messageId,
      storageKey: "recordings/launch-review.mp4",
    });
    expect(recording.calls[0]?.text).toContain("set_config('helix.org_id'");
    expect(recording.calls[2]?.text).toContain("for update");
    expect(recording.calls[3]?.text).toContain("o.storage_key");
    expect(recording.calls[4]?.text).toContain("insert into objects");
    expect(recording.calls[4]?.text).toContain("'recording'");
    expect(recording.calls[5]?.text).toContain("insert into meet_recording_governance");
    expect(recording.calls[5]?.values).toEqual(
      expect.arrayContaining([attachment?.objectId, roomId, threadId]),
    );
    expect(recording.calls[6]?.text).toContain("helix_commit_storage_usage");
    expect(recording.calls[6]?.values).toEqual([
      orgId,
      attachment?.objectId,
      4096,
      "meet_recordings",
    ]);
    expect(recording.calls[7]?.text).toContain("insert into messages");
    expect(recording.calls[7]?.values).toContain(threadId);
    expect(recording.calls[8]?.text).toContain("insert into message_attachments");
    expect(recording.calls[8]?.values).toContain(attachment?.objectId);
    expect(recording.calls.some((call) => call.text.includes("'object'"))).toBe(false);
  });

  it("persists recording usage through the transactional quota function", async () => {
    const recording = createRecordingSql([
      [],
      [roomRow()],
      [],
      [],
      [],
      [],
      [{ id: messageId }],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(
      store.attachRecording({
        orgId,
        actorId,
        roomId,
        storageKey: "recordings/launch-review.mp4",
        byteSize: 4096,
      }),
    ).resolves.toMatchObject({
      roomId,
      threadId,
      messageId,
    });
    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      true,
    );
  });

  it("returns an existing recording attachment for duplicate completion payloads", async () => {
    const recording = createRecordingSql([
      [],
      [roomRow()],
      [],
      [
        {
          object_id: objectId,
          message_id: messageId,
          storage_key: "recordings/launch-review.mp4",
        },
      ],
    ]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(
      store.attachRecording({
        orgId,
        actorId,
        roomId,
        storageKey: "recordings/launch-review.mp4",
        byteSize: 4096,
      }),
    ).resolves.toEqual({
      roomId,
      threadId,
      objectId,
      messageId,
      storageKey: "recordings/launch-review.mp4",
    });

    expect(recording.calls).toHaveLength(4);
    expect(recording.calls[3]?.text).toContain("o.storage_key");
  });

  it("does not commit storage usage when recording attachment cannot resolve a room", async () => {
    const recording = createRecordingSql([[], []]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(
      store.attachRecording({
        orgId,
        actorId,
        roomId,
        storageKey: "recordings/missing-room.mp4",
        byteSize: 4096,
      }),
    ).resolves.toBeNull();

    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      false,
    );
  });

  it("loads recording artifact summaries with visible room lists", async () => {
    const recording = createRecordingSql([
      [
        {
          ...roomRow(),
          recording_artifacts: [
            {
              objectId,
              messageId,
              storageKey: "recordings/launch-review.mp4",
              mimeType: "video/mp4",
              byteSize: 4096,
              createdAt: now,
              startedAt: "2026-05-20T12:00:00.000Z",
              endedAt: "2026-05-20T12:30:00.000Z",
              metadata: { source: "jibri" },
            },
          ],
        },
      ],
    ]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(store.listRoomsForActor({ orgId, actorId, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        id: roomId,
        recordingArtifacts: [
          expect.objectContaining({
            storageKey: "recordings/launch-review.mp4",
            byteSize: 4096,
            startedAt: new Date("2026-05-20T12:00:00.000Z"),
          }),
        ],
      }),
    ]);
    expect(recording.calls[0]?.text).toContain("jsonb_agg");
    expect(recording.calls[0]?.text).toContain("message_attachments");
    expect(recording.calls[0]?.text).toContain("o.kind = 'recording'");
  });

  it("derives moderation from the authoritative same-org host/cohost state", async () => {
    const recording = createRecordingSql([[{ id: roomId }]]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(store.canModerateRoom({ orgId, actorId, roomId })).resolves.toBe(true);
    expect(recording.calls[0]?.text).toContain("actor.org_id = r.org_id");
    expect(recording.calls[0]?.text).toContain("actor.disabled_at is null");
    expect(recording.calls[0]?.text).toContain("r.host_actor_id");
    expect(recording.calls[0]?.text).toContain("any(r.cohost_actor_ids)");
  });

  it("does not end a room for an attendee without a moderator grant", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(store.endRoom({ orgId, actorId, roomId })).resolves.toBeNull();
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).not.toContain("update meet_rooms");
  });
});

function roomRow() {
  return {
    id: roomId,
    org_id: orgId,
    thread_id: threadId,
    room_name: "launch-review",
    subject: "Launch review",
    jitsi_domain: "meet.helix.test",
    created_by_actor_id: actorId,
    started_at: now,
    ended_at: null,
    status: "active",
    metadata: {},
    created_at: now,
    updated_at: now,
  };
}
function createRecordingSql(responses: readonly (readonly unknown[])[]) {
  const queue = [...responses];
  const recording = sharedRecordingSql(({ text, values }) => {
    if (text.includes("helix_commit_storage_usage")) {
      return Promise.resolve([
        {
          accepted: true,
          used_bytes: String(values[2]),
          reserved_bytes: "0",
          limit_bytes: null,
          projected_bytes: String(values[2]),
        },
      ]);
    }
    return Promise.resolve(queue.shift() ?? []);
  }, "$");
  return {
    ...recording,
    get transactions() {
      return recording.beginCalls;
    },
    get beginCalls() {
      return recording.beginCalls;
    },
  };
}
