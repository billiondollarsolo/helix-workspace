import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "44444444-4444-4444-8444-444444444444";

function createRecordingSql(responses: readonly (readonly unknown[])[] = []): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (
      text.trim().startsWith("(") &&
      (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id"))
    ) {
      return { text, values };
    }
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

describe("PostgresDriveStore comment query shape", () => {
  it("scopes PDF form state lookups by org, object, actor, and PDF permissions", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          id: objectId,
          org_id: orgId,
          owner_actor_id: actorId,
          kind: "file",
          storage_key: "drive/test/report.pdf",
          mime_type: "application/pdf",
          byte_size: 128,
          sha256: "a".repeat(64),
          metadata: {},
          deleted_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.getPdfFormState({ orgId, actorId, objectId })).resolves.toBeNull();

    const accessQuery = recording.calls.find((call) =>
      call.text.includes("mime_type = 'application/pdf'"),
    );
    expect(accessQuery?.text).toContain("p.org_id = ?");
    expect(accessQuery?.values).toEqual(expect.arrayContaining([orgId, actorId, objectId]));

    const stateQuery = recording.calls.find((call) =>
      call.text.includes("from drive_pdf_form_states s"),
    );
    expect(stateQuery?.text).toContain("s.org_id = ?");
    expect(stateQuery?.text).toContain("s.object_id = ?");
    expect(stateQuery?.text).toContain("s.actor_id = ?");
    expect(stateQuery?.values).toEqual(expect.arrayContaining([orgId, objectId, actorId]));
  });

  it("fans out Drive comment mention notifications to matched object collaborators", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const mentionedActorId = "55555555-5555-4555-8555-555555555555";
    const commentId = "66666666-6666-4666-8666-666666666666";
    const recording = createRecordingSql([
      [
        {
          id: objectId,
          org_id: orgId,
          owner_actor_id: actorId,
          kind: "file",
          storage_key: "drive/test/roadmap.slide",
          mime_type: "application/vnd.helix.slides",
          byte_size: 128,
          sha256: "a".repeat(64),
          metadata: { app: "slides", title: "Roadmap deck" },
          deleted_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      [
        {
          id: commentId,
          org_id: orgId,
          object_id: objectId,
          parent_comment_id: null,
          actor_id: actorId,
          anchor: { kind: "slides-slide", slideId: "slide-1" },
          body: "Can @maya review slide one?",
          status: "open",
          metadata: { mentionsText: ["Maya Chen", "missing"] },
          resolved_at: null,
          created_at: now,
          updated_at: null,
        },
      ],
      [],
      [],
      [],
      [
        { id: actorId, display_name: "Owner Admin", email: "owner@example.com" },
        { id: mentionedActorId, display_name: "Maya Chen", email: "maya@example.com" },
      ],
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          org_id: orgId,
          actor_id: mentionedActorId,
          verb: "drive.comment.mention",
          object_type: "drive.object",
          object_id: objectId,
          summary: 'Owner Admin mentioned you in "Roadmap deck".',
          body: "Can @maya review slide one?",
          payload: {},
          created_at: now,
          read_at: null,
        },
      ],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await store.createComment({
      orgId,
      actorId,
      objectId,
      body: "Can @maya review slide one?",
      anchor: { kind: "slides-slide", slideId: "slide-1" },
      metadata: { mentionsText: ["Maya Chen", "missing"] },
    });

    const actorLookup = recording.calls.find(
      (call) => call.text.includes("from actors") && call.text.includes("permissions"),
    );
    expect(actorLookup?.text).toContain("p.resource_type = 'object'");
    expect(actorLookup?.text).toContain("p.resource_id = ?");
    expect(actorLookup?.values).toEqual(expect.arrayContaining([orgId, objectId]));

    const notificationInsert = recording.calls.find((call) =>
      call.text.includes("insert into notifications"),
    );
    expect(notificationInsert?.values).toEqual(
      expect.arrayContaining([
        orgId,
        mentionedActorId,
        "drive.comment.mention",
        "drive.object",
        objectId,
        'Owner Admin mentioned you in "Roadmap deck".',
        "Can @maya review slide one?",
      ]),
    );
    expect(notificationInsert?.values[7]).toMatchObject({
      objectId,
      commentId,
      anchor: { kind: "slides-slide", slideId: "slide-1" },
      mentionedByActorId: actorId,
      mentionsText: ["maya chen", "missing", "maya"],
      app: "slides",
    });
  });
});
