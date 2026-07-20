import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
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
    if (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id")) {
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
  return {
    sql,
    calls,
  };
}

describe("PostgresDriveStore query shape", () => {
  it("scopes Drive list permission predicates to the request org", async () => {
    const recording = createRecordingSql();
    const store = new PostgresDriveStore(recording.sql);

    await store.list({ orgId, actorId, limit: 10 });

    const permissionQueries = recording.calls.filter((call) =>
      call.text.includes("from permissions p"),
    );
    expect(permissionQueries).toHaveLength(2);
    expect(permissionQueries.every((call) => call.text.includes("p.org_id = ?"))).toBe(true);
    expect(permissionQueries.every((call) => call.values.includes(orgId))).toBe(true);
  });

  it("projects mine and shared count metadata from Drive list permissions", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          id: objectId,
          org_id: orgId,
          owner_actor_id: "99999999-9999-4999-8999-999999999999",
          kind: "file",
          storage_key: "drive/test/shared.pdf",
          mime_type: "application/pdf",
          byte_size: 128,
          sha256: "a".repeat(64),
          metadata: { name: "shared.pdf" },
          version_number: 3,
          mine: false,
          shared_count: "2",
          deleted_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.list({ orgId, actorId, acrossFolders: true })).resolves.toMatchObject([
      {
        id: objectId,
        metadata: { name: "shared.pdf", mine: false, sharedCount: 2 },
      },
    ]);

    const fileQuery = recording.calls.find((call) => call.text.includes("from objects o"));
    expect(fileQuery?.text).toContain("as mine");
    expect(fileQuery?.text).toContain("as shared_count");
    expect(fileQuery?.text).toContain("count(distinct p.actor_id)");
    expect(fileQuery?.values).toEqual(expect.arrayContaining([orgId, actorId]));
  });

  it("scopes Drive search permission predicates to the request org", async () => {
    const recording = createRecordingSql();
    const store = new PostgresDriveStore(recording.sql);

    await store.search({ orgId, actorId, query: "plan" });

    const query = recording.calls.find((call) => call.text.includes("from permissions p"));
    expect(query?.text).toContain("p.org_id = ?");
    expect(query?.values).toContain(orgId);
  });

  it("scopes object access helper predicates to the request org", async () => {
    const recording = createRecordingSql();
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.readFile({ orgId, actorId, objectId })).rejects.toThrow(
      "Unknown or inaccessible Drive object",
    );

    const query = recording.calls.find((call) => call.text.includes("from permissions p"));
    expect(query?.text).toContain("p.org_id = ?");
    expect(query?.values).toContain(orgId);
  });

  it("updates access roles only for owner-managed object grants in the request org", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    // First response: requireObjectAccess (owner path → requireObjectRole passes).
    // Second response: update CTE returns no rows → null grant.
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
          metadata: { name: "report.pdf" },
          deleted_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(
      store.updateAccess({
        orgId,
        actorId,
        objectId,
        targetActorId: "55555555-5555-4555-8555-555555555555",
        role: "editor",
      }),
    ).resolves.toBeNull();

    const query = recording.calls.find((call) => call.text.includes("update permissions p"));
    expect(query?.text).toContain("p.org_id = ?");
    expect(query?.text).toContain("o.owner_actor_id = ?");
    expect(query?.text).toContain("p.actor_id <> o.owner_actor_id");
    expect(query?.values).toEqual(expect.arrayContaining([orgId, actorId, objectId, "editor"]));
  });

  it("scopes PDF form state lookups by org, object, actor, and object permissions", async () => {
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
          created_at: new Date("2026-05-20T12:00:00.000Z"),
          updated_at: new Date("2026-05-20T12:00:00.000Z"),
        },
      ],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.getPdfFormState({ orgId, actorId, objectId })).resolves.toBeNull();

    const permissionQuery = recording.calls.find((call) =>
      call.text.includes("from permissions p"),
    );
    expect(permissionQuery?.text).toContain("p.org_id = ?");
    expect(permissionQuery?.values).toContain(orgId);

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
        {
          id: actorId,
          display_name: "Owner Admin",
          email: "owner@example.com",
        },
        {
          id: mentionedActorId,
          display_name: "Maya Chen",
          email: "maya@example.com",
        },
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

  it("scopes folder access helper predicates to the request org", async () => {
    const recording = createRecordingSql();
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.list({ orgId, actorId, folderId })).rejects.toThrow(
      "Unknown or inaccessible Drive folder",
    );

    const query = recording.calls.find((call) => call.text.includes("from permissions p"));
    expect(query?.text).toContain("p.org_id = ?");
    expect(query?.values).toContain(orgId);
  });
});
