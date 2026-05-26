import { createHash } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { TenantStorageResolver } from "../storage/index.js";
import { type DriveStorageClient, PostgresDriveStore } from "./store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-05-20T12:00:00.000Z");

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

function objectRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: objectId,
    org_id: orgId,
    owner_actor_id: actorId,
    kind: "file",
    storage_key: `drive/${orgId}/${objectId}/v1/report.txt`,
    mime_type: "text/plain",
    byte_size: 0,
    sha256: null,
    metadata: { name: "report.txt", status: "pending_upload" },
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function versionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    org_id: orgId,
    object_id: objectId,
    version_number: 1,
    storage_key: `drive/${orgId}/${objectId}/v1/report.txt`,
    mime_type: "text/plain",
    byte_size: 0,
    sha256: "0".repeat(64),
    metadata: {},
    created_by_actor_id: actorId,
    created_at: now,
    ...overrides,
  };
}

describe("PostgresDriveStore comment query shape", () => {
  it("prepares uploads through the tenant storage resolver when configured", async () => {
    const storageCalls: string[] = [];
    const storage = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
      presignPutUrl: async (key: string, options?: { readonly contentType?: string }) => {
        storageCalls.push(`presign-put:${key}:${options?.contentType ?? ""}`);
        return `put://${key}`;
      },
    } satisfies DriveStorageClient;
    const resolvedOrgIds: string[] = [];
    const storageResolver: TenantStorageResolver = async ({ orgId: resolvedOrgId }) => {
      resolvedOrgIds.push(resolvedOrgId);
      return { client: storage, managedBy: "helix-default", prefix: "" };
    };
    const recording = createRecordingSql([[objectRow()], [], [], [], []]);
    const store = new PostgresDriveStore(recording.sql, undefined, { storageResolver });

    const upload = await store.prepareUpload({
      orgId,
      actorId,
      name: "report.txt",
      mimeType: "text/plain",
    });

    expect(upload.uploadUrl).toMatch(/^put:\/\/drive\//u);
    expect(resolvedOrgIds).toEqual([orgId]);
    expect(storageCalls).toHaveLength(1);
    expect(storageCalls[0]).toContain(`presign-put:drive/${orgId}/`);
    expect(storageCalls[0]).toContain(":text/plain");
  });

  it("propagates resolver presigned-write blocking during upload preparation", async () => {
    const storage = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
      presignPutUrl: async () => {
        throw new Error("Tenant storage migration job-1 is in progress; presigned writes blocked.");
      },
    } satisfies DriveStorageClient;
    const storageResolver: TenantStorageResolver = async () => ({
      client: storage,
      managedBy: "helix-default",
      prefix: "",
    });
    const recording = createRecordingSql([[objectRow()], [], [], [], []]);
    const store = new PostgresDriveStore(recording.sql, undefined, { storageResolver });

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "report.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("presigned writes blocked");
  });

  it("finalizes inline uploads through the tenant storage resolver when configured", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const putCalls: {
      readonly key: string;
      readonly body: Uint8Array;
      readonly contentType: string | undefined;
      readonly metadata: Record<string, string> | undefined;
    }[] = [];
    const storage = {
      put: async (object) => {
        putCalls.push({
          key: object.key,
          body: object.body as Uint8Array,
          contentType: object.contentType,
          metadata: object.metadata,
        });
      },
      get: async () => null,
      delete: async () => {},
    } satisfies DriveStorageClient;
    const resolvedOrgIds: string[] = [];
    const storageResolver: TenantStorageResolver = async ({ orgId: resolvedOrgId }) => {
      resolvedOrgIds.push(resolvedOrgId);
      return { client: storage, managedBy: "helix-default", prefix: "" };
    };
    const storageKey = `drive/${orgId}/${objectId}/v1/report.txt`;
    const recording = createRecordingSql([
      [
        objectRow({
          storage_key: storageKey,
          mime_type: "text/plain",
          metadata: { name: "report.txt", status: "pending_upload" },
        }),
      ],
      [
        versionRow({
          storage_key: storageKey,
          byte_size: body.byteLength,
          sha256,
        }),
      ],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, { storageResolver });

    await store.finalizeUpload({
      orgId,
      actorId,
      objectId,
      byteSize: body.byteLength,
      sha256,
      content: body,
    });

    expect(resolvedOrgIds).toEqual([orgId]);
    expect(putCalls).toEqual([
      {
        key: storageKey,
        body,
        contentType: "text/plain",
        metadata: { objectId, sha256 },
      },
    ]);
  });

  it("fails closed for inline finalized content when no storage client is configured", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const recording = createRecordingSql([
      [
        objectRow({
          metadata: { name: "report.txt", status: "pending_upload" },
        }),
      ],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: body.byteLength,
        sha256,
        content: body,
      }),
    ).rejects.toThrow("Drive content storage is not configured");
  });

  it("scopes PDF form state lookups by org, object, actor, and PDF permissions", async () => {
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
