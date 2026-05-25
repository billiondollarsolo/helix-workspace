import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type {
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk-types";
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
const objectId = "66666666-6666-4666-8666-666666666666";

describe("Postgres Meet store recording attachments", () => {
  it("creates recording object state, attaches it to the call thread, and grants participant object access", async () => {
    const metering = new RecordingMeteringClient();
    const recording = createRecordingSql([
      [roomRow()],
      [],
      [],
      [],
      [{ id: messageId }],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresMeetStore(recording.sql, { metering });

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
    expect(recording.calls[1]?.text).toContain("for update");
    expect(recording.calls[2]?.text).toContain("o.storage_key");
    expect(recording.calls[3]?.text).toContain("insert into objects");
    expect(recording.calls[3]?.text).toContain("'recording'");
    expect(recording.calls[4]?.text).toContain("insert into messages");
    expect(recording.calls[4]?.values).toContain(threadId);
    expect(recording.calls[5]?.text).toContain("insert into message_attachments");
    expect(recording.calls[5]?.values).toContain(attachment?.objectId);
    expect(recording.calls[6]?.text).toContain("insert into permissions");
    expect(recording.calls[6]?.text).toContain("resource_type in ('meet_room', 'thread')");
    expect(recording.calls[6]?.values).toContain(attachment?.objectId);
    expect(recording.calls[6]?.values).toContain(roomId);
    expect(recording.calls[6]?.values).toContain(threadId);
    expect(metering.records).toEqual([
      {
        orgId,
        event: {
          type: "storage.delta",
          quantity: 4096,
          metadata: {
            bucket: "meet_recordings",
            byte_delta: 4096,
          },
        },
      },
    ]);

    const metadataJson = JSON.stringify(metering.records[0]?.event.metadata);
    expect(metadataJson).not.toContain(roomId);
    expect(metadataJson).not.toContain(threadId);
    expect(metadataJson).not.toContain(String(attachment?.objectId));
    expect(metadataJson).not.toContain(actorId);
    expect(metadataJson).not.toContain("recordings/launch-review.mp4");
    expect(metadataJson).not.toContain("Launch review");
    expect(metadataJson).not.toContain("jibri");
  });

  it("does not fail recording attachment when storage metering emission fails", async () => {
    const errors: unknown[] = [];
    const metering = new RecordingMeteringClient({ reject: true });
    const recording = createRecordingSql([
      [roomRow()],
      [],
      [],
      [],
      [{ id: messageId }],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresMeetStore(recording.sql, {
      metering,
      onMeteringError(error) {
        errors.push(error);
      },
    });

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
    await Promise.resolve();

    expect(metering.records).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("returns an existing recording attachment for duplicate completion payloads", async () => {
    const metering = new RecordingMeteringClient();
    const recording = createRecordingSql([
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
    const store = new PostgresMeetStore(recording.sql, { metering });

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

    expect(recording.calls).toHaveLength(3);
    expect(recording.calls[2]?.text).toContain("o.storage_key");
    expect(metering.records).toEqual([]);
  });

  it("does not emit storage metering when recording attachment cannot resolve a room", async () => {
    const metering = new RecordingMeteringClient();
    const recording = createRecordingSql([[]]);
    const store = new PostgresMeetStore(recording.sql, { metering });

    await expect(
      store.attachRecording({
        orgId,
        actorId,
        roomId,
        storageKey: "recordings/missing-room.mp4",
        byteSize: 4096,
      }),
    ).resolves.toBeNull();

    expect(metering.records).toHaveLength(0);
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

class RecordingMeteringClient implements MeteringClient {
  readonly records: {
    readonly orgId: string;
    readonly event: MeteringEvent;
    readonly trace?: TraceContext | undefined;
  }[] = [];

  constructor(private readonly options: { readonly reject?: boolean } = {}) {}

  async emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
    this.records.push({ orgId, event, ...(trace === undefined ? {} : { trace }) });
    if (this.options.reject === true) {
      throw new Error("metering unavailable");
    }
  }

  async emitBatch(events: readonly MeteringEmitInput[]): Promise<void> {
    for (const input of events) {
      await this.emit(input.orgId, input.event, input.trace);
    }
  }
}
