import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk-types";
import {
  createNativeDocumentState,
  documentTextFromStoredState,
  HELIX_NATIVE_DOCUMENT_ENGINE,
  replaceFirstTextInStoredState,
} from "./native-state.js";
import { PostgresDocsStore } from "./store.js";
import type { TenantStorageClient } from "../storage/index.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-05-24T12:00:00.000Z");

describe("PostgresDocsStore tenant storage", () => {
  it("migrates legacy document state into native Yjs state and storage", async () => {
    const storage = new RecordingStorageClient();
    const legacy = Buffer.from("Legacy body", "utf8");
    const recording = createRecordingSql([
      [
        documentRow({
          ydocState: legacy,
          ydocStateVector: null,
          editorEngine: "legacy-yjs",
          updateSeq: 1,
        }),
      ],
      [
        documentRow({
          ydocState: createNativeDocumentState("Legacy body").state,
          ydocStateVector: createNativeDocumentState("Legacy body").stateVector,
          editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
          updateSeq: 2,
        }),
      ],
      [],
      [],
      [],
    ]);
    const store = new PostgresDocsStore(recording.sql, {
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    const document = await store.migrateToNativeDocument({
      orgId,
      actorId,
      documentId,
    });

    expect(document).toMatchObject({
      id: documentId,
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
      formatVersion: 1,
      updateSeq: 2,
    });
    const update = recording.calls.find((call) => call.text.includes("editor_engine = ?"));
    expect(update?.values).toContain(HELIX_NATIVE_DOCUMENT_ENGINE);
    const docsUpdate = recording.calls.find((call) =>
      call.text.includes("insert into docs_updates"),
    );
    expect(JSON.stringify(docsUpdate?.values)).toContain("docs.migrate-native");
    const objectUpdate = recording.calls.find((call) => call.text.includes("update objects"));
    expect(objectUpdate?.values).toContain(`docs/${orgId}/${documentId}`);
    expect(storage.puts).toHaveLength(1);
    expect(documentTextFromStoredState(storagePutBody(storage, 0))).toBe("Legacy body");
  });

  it("accepts anchored native suggestions at the recorded selection", async () => {
    const suggestionId = "55555555-5555-4555-8555-555555555555";
    const initial = createNativeDocumentState("First repeat\n\nSecond repeat");
    const recording = createRecordingSql([
      [
        suggestionRow({
          id: suggestionId,
          beforeText: "repeat",
          afterText: "choice",
          status: "pending",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId,
            formatVersion: 1,
            selection: { from: 22, to: 28, text: "repeat" },
            quote: "repeat",
          },
        }),
      ],
      [documentRow({ ydocState: initial.state, ydocStateVector: initial.stateVector })],
      [{ ydoc_state: initial.state }],
      [{ update_seq: 1 }],
      [],
      [
        suggestionRow({
          id: suggestionId,
          beforeText: "repeat",
          afterText: "choice",
          status: "accepted",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId,
            formatVersion: 1,
            selection: { from: 22, to: 28, text: "repeat" },
            quote: "repeat",
          },
        }),
      ],
      [],
    ]);
    const store = new PostgresDocsStore(recording.sql);

    const resolved = await store.resolveSuggestion({
      orgId,
      actorId,
      suggestionId,
      status: "accepted",
    });

    expect(resolved?.status).toBe("accepted");
    const documentUpdate = recording.calls.find((call) => call.text.includes("ydoc_state = ?"));
    const updatedState = documentUpdate?.values.find((value) => Buffer.isBuffer(value));
    expect(Buffer.isBuffer(updatedState)).toBe(true);
    expect(documentTextFromStoredState(updatedState as Buffer)).toBe("First repeat\nSecond choice");
  });

  it("accepts multiple native suggestions in one batch transaction", async () => {
    const firstSuggestionId = "55555555-5555-4555-8555-555555555555";
    const secondSuggestionId = "66666666-6666-4666-8666-666666666666";
    const initial = createNativeDocumentState("teh plan\n\nrecieve update");
    const afterFirst = replaceFirstTextInStoredState({
      state: initial.state,
      beforeText: "teh",
      afterText: "the",
    });
    if (afterFirst === null) {
      throw new Error("Expected first suggestion replacement to succeed.");
    }
    const recording = createRecordingSql([
      [documentRow({ ydocState: initial.state, ydocStateVector: initial.stateVector })],
      [
        suggestionRow({
          id: firstSuggestionId,
          beforeText: "teh",
          afterText: "the",
          status: "pending",
          anchor: {},
        }),
        suggestionRow({
          id: secondSuggestionId,
          beforeText: "recieve",
          afterText: "receive",
          status: "pending",
          anchor: {},
        }),
      ],
      [{ ydoc_state: initial.state }],
      [{ update_seq: 1 }],
      [],
      [
        suggestionRow({
          id: firstSuggestionId,
          beforeText: "teh",
          afterText: "the",
          status: "accepted",
          anchor: {},
        }),
      ],
      [],
      [],
      [],
      [{ ydoc_state: afterFirst.state }],
      [{ update_seq: 2 }],
      [],
      [
        suggestionRow({
          id: secondSuggestionId,
          beforeText: "recieve",
          afterText: "receive",
          status: "accepted",
          anchor: {},
        }),
      ],
      [],
    ]);
    const store = new PostgresDocsStore(recording.sql);

    const resolved = await store.resolveSuggestions({
      orgId,
      actorId,
      documentId,
      suggestionIds: [firstSuggestionId, secondSuggestionId],
      status: "accepted",
    });

    expect(resolved?.map((suggestion) => suggestion.status)).toEqual(["accepted", "accepted"]);
    const documentUpdates = recording.calls.filter((call) => call.text.includes("ydoc_state = ?"));
    const finalState = documentUpdates.at(-1)?.values.find((value) => Buffer.isBuffer(value));
    expect(Buffer.isBuffer(finalState)).toBe(true);
    expect(documentTextFromStoredState(finalState as Buffer)).toBe("the plan\nreceive update");
  });

  it("fans out Docs comment mention notifications to matched actors", async () => {
    const commentId = "55555555-5555-4555-8555-555555555555";
    const mentionedActorId = "66666666-6666-4666-8666-666666666666";
    const recording = createRecordingSql([
      [documentRow({ ydocState: Buffer.from("state"), ydocStateVector: null })],
      [
        commentRow({
          id: commentId,
          actorId,
          parentCommentId: null,
          body: "Can @grace review this?",
          metadata: { mentionsText: ["grace", "missing", "grace"] },
        }),
      ],
      [],
      [],
      [],
      [
        { id: actorId, display_name: "Ada Lovelace", email: "ada@example.test" },
        { id: mentionedActorId, display_name: "Grace Hopper", email: "grace@example.test" },
      ],
      [{ title: "Launch" }],
      [notificationRow({ actorId: mentionedActorId, objectId: documentId })],
    ]);
    const store = new PostgresDocsStore(recording.sql);

    const comment = await store.createComment({
      orgId,
      actorId,
      documentId,
      body: "Can @grace review this?",
      metadata: { mentionsText: ["grace", "missing", "grace"] },
    });

    expect(comment.id).toBe(commentId);
    const notificationInsert = recording.calls.find((call) =>
      call.text.includes("insert into notifications"),
    );
    expect(notificationInsert?.values).toContain(mentionedActorId);
    expect(notificationInsert?.values).toContain("docs.comment.mention");
    expect(notificationInsert?.values).toContain(`Ada Lovelace mentioned you in "Launch".`);
    expect(JSON.stringify(notificationInsert?.values)).toContain(commentId);
    expect(JSON.stringify(notificationInsert?.values)).toContain("grace");
    expect(JSON.stringify(notificationInsert?.values)).toContain("missing");
    const actorLookup = recording.calls.find((call) => call.text.includes("from actors"));
    expect(actorLookup?.text).toContain("permissions");
  });

  it("persists native document state through the tenant storage resolver on create", async () => {
    const initial = createNativeDocumentState("# Launch\n\nShip it.");
    const storage = new RecordingStorageClient();
    const resolvedOrgIds: string[] = [];
    const recording = createRecordingSql([
      [{ id: threadId }],
      [documentRow({ ydocState: initial.state, ydocStateVector: initial.stateVector })],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDocsStore(recording.sql, {
      storageResolver: async ({ orgId: resolvedOrgId }) => {
        resolvedOrgIds.push(resolvedOrgId);
        return { client: storage, managedBy: "helix-default", prefix: `tenants/${resolvedOrgId}/` };
      },
    });

    const document = await store.create({
      orgId,
      actorId,
      title: "Launch",
      initialMarkdown: "# Launch\n\nShip it.",
      editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
    });

    expect(document.id).toBe(documentId);
    expect(resolvedOrgIds).toEqual([orgId]);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({
      key: `docs/${orgId}/${documentId}`,
      contentType: "application/vnd.helix.document",
      metadata: { documentId, orgId },
    });
    const storedBody = storagePutBody(storage, 0);
    expect(documentTextFromStoredState(storedBody)).toBe("Launch\nShip it.");
    const objectInsert = recording.calls.find((call) => call.text.includes("insert into objects"));
    expect(objectInsert?.values).toContain(`docs/${orgId}/${documentId}`);
    expect(objectInsert?.values).toContain(storedBody.byteLength);
  });

  it("updates object metadata and tenant storage bytes when compacting document state", async () => {
    const compacted = createNativeDocumentState("Compacted body");
    const storage = new RecordingStorageClient();
    const recording = createRecordingSql([
      [documentRow({ ydocState: compacted.state, ydocStateVector: compacted.stateVector })],
      [],
    ]);
    const store = new PostgresDocsStore(recording.sql, {
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    const document = await store.compactDocument({
      orgId,
      documentId,
      state: compacted.state,
      stateVector: compacted.stateVector,
    });

    expect(document?.id).toBe(documentId);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({
      key: `docs/${orgId}/${documentId}`,
      contentType: "application/vnd.helix.document",
      metadata: { documentId, orgId },
    });
    expect(storagePutBody(storage, 0).equals(compacted.state)).toBe(true);
    const objectUpdate = recording.calls.find((call) => call.text.includes("update objects"));
    expect(objectUpdate?.values).toContain(`docs/${orgId}/${documentId}`);
    expect(objectUpdate?.values).toContain(compacted.state.byteLength);
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly unknown[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: readonly unknown[]) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function documentRow(input: {
  readonly ydocState: Buffer;
  readonly ydocStateVector: Buffer | null;
  readonly editorEngine?: string | undefined;
  readonly updateSeq?: number | undefined;
}): Record<string, unknown> {
  return {
    id: documentId,
    org_id: orgId,
    title: "Launch",
    thread_id: threadId,
    owner_actor_id: actorId,
    created_by_actor_id: actorId,
    ydoc_state: input.ydocState,
    ydoc_state_vector: input.ydocStateVector,
    update_seq: input.updateSeq ?? 0,
    editor_engine: input.editorEngine ?? HELIX_NATIVE_DOCUMENT_ENGINE,
    format_version: 1,
    metadata: {},
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

function commentRow(input: {
  readonly id: string;
  readonly actorId: string;
  readonly parentCommentId: string | null;
  readonly body: string;
  readonly metadata: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.id,
    org_id: orgId,
    document_id: documentId,
    parent_comment_id: input.parentCommentId,
    actor_id: input.actorId,
    anchor: {},
    body: input.body,
    status: "open",
    metadata: input.metadata,
    resolved_at: null,
    created_at: now,
    updated_at: now,
  };
}

function suggestionRow(input: {
  readonly id: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly status: string;
  readonly anchor: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.id,
    org_id: orgId,
    document_id: documentId,
    actor_id: actorId,
    anchor: input.anchor,
    before_text: input.beforeText,
    after_text: input.afterText,
    reason: "typo",
    status: input.status,
    metadata: {},
    resolved_by_actor_id: input.status === "pending" ? null : actorId,
    resolved_at: input.status === "pending" ? null : now,
    created_at: now,
    updated_at: now,
  };
}

function notificationRow(input: {
  readonly actorId: string;
  readonly objectId: string;
}): Record<string, unknown> {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    org_id: orgId,
    actor_id: input.actorId,
    verb: "docs.comment.mention",
    object_type: "document",
    object_id: input.objectId,
    summary: 'Ada Lovelace mentioned you in "Launch".',
    body: "Can @grace review this?",
    payload: {},
    created_at: now,
    read_at: null,
  };
}

class RecordingStorageClient implements TenantStorageClient {
  readonly puts: StorageObject[] = [];

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<StorageObject | null> {
    throw new Error("Not implemented for docs storage tests.");
  }

  async delete(): Promise<void> {
    throw new Error("Not implemented for docs storage tests.");
  }
}

function storagePutBody(storage: RecordingStorageClient, index: number): Buffer {
  const body = storage.puts[index]?.body;
  if (body === undefined || Symbol.asyncIterator in body) {
    throw new Error("Expected storage put body to be an in-memory byte array.");
  }
  return Buffer.from(body);
}
