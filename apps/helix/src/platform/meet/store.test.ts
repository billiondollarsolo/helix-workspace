import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresMeetStore } from "./store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const now = new Date("2026-05-20T12:00:00.000Z");
const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const roomId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const messageId = "55555555-5555-4555-8555-555555555555";

describe("Postgres Meet store recording attachments", () => {
  it("creates recording object state, attaches it to the call thread, and grants participant object access", async () => {
    const recording = createRecordingSql([[roomRow()], [], [{ id: messageId }], [], [], [], []]);
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
    expect(recording.calls[1]?.text).toContain("insert into objects");
    expect(recording.calls[1]?.text).toContain("'recording'");
    expect(recording.calls[2]?.text).toContain("insert into messages");
    expect(recording.calls[2]?.values).toContain(threadId);
    expect(recording.calls[3]?.text).toContain("insert into message_attachments");
    expect(recording.calls[3]?.values).toContain(attachment?.objectId);
    expect(recording.calls[4]?.text).toContain("insert into permissions");
    expect(recording.calls[4]?.text).toContain("resource_type in ('meet_room', 'thread')");
    expect(recording.calls[4]?.values).toContain(attachment?.objectId);
    expect(recording.calls[4]?.values).toContain(roomId);
    expect(recording.calls[4]?.values).toContain(threadId);
  });

  it("loads recording artifact summaries with visible room lists", async () => {
    const recording = createRecordingSql([
      [
        {
          ...roomRow(),
          recording_artifacts: [
            {
              objectId: "66666666-6666-4666-8666-666666666666",
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

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
