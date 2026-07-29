import { createHash } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type {
  EventBus,
  EventEnvelope,
  JsonValue,
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { DriveStorageQuotaExceededError, PostgresDriveStore } from "./store.js";
import { createPrefixedStorageClient, type TenantStorageClient } from "../storage/index.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";

function bytesOfSize(size: number, value: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(value);
  return bytes;
}

describe("PostgresDriveStore metering", () => {
  it("emits positive storage.delta after a prepared upload is finalized", async () => {
    const content = bytesOfSize(128, 1);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const metering = new RecordingMeteringClient();
    const storage = new RecordingStorageClient();
    const recording = createRecordingSql([
      [objectRow({ byteSize: 128, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: 1_000, used: 0 })],
      [versionRow({ byteSize: 128, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, storage, { metering });

    await store.finalizeUpload({
      orgId,
      actorId,
      objectId,
      byteSize: 128,
      sha256,
      mimeType: "text/plain",
      content,
      metadata: {},
    });

    expect(metering.records).toEqual([
      {
        orgId,
        event: {
          type: "storage.delta",
          quantity: 128,
          metadata: { bucket: "drive", byte_delta: 128 },
        },
      },
    ]);
    const metadataJson = JSON.stringify(metering.records[0]?.event.metadata);
    expect(metadataJson).not.toContain(objectId);
    expect(metadataJson).not.toContain(actorId);
    expect(metadataJson).not.toContain("report.txt");
    expect(metadataJson).not.toContain("text/plain");
    expect(metadataJson).not.toContain("sha256");
  });

  it("rejects using finalize to replace an already-active object", async () => {
    const metering = new RecordingMeteringClient();
    const recording = createRecordingSql([
      [objectRow({ byteSize: 200, metadata: { name: "report.txt", status: "ready" } })],
      [versionRow({ byteSize: 150, versionNumber: 2 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, { metering });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 150,
        sha256: "b".repeat(64),
        mimeType: "text/plain",
        metadata: {},
      }),
    ).rejects.toThrow("cannot be finalized from state 'active'");

    expect(metering.records).toEqual([]);
  });

  it("emits a negative storage.delta for hard deletes using distinct stored keys", async () => {
    const metering = new RecordingMeteringClient();
    const deletedRows = Object.assign([], { count: 1 }) as unknown[];
    const recording = createRecordingSql([
      [
        objectRow({
          byteSize: 200,
          storageKey: "drive/org/file/current",
          hardDeleteReady: true,
        }),
      ],
      [{ active_share_count: 0, pending_job_count: 0 }],
      [
        { storage_key: "drive/org/file/current", byte_size: 200 },
        { storage_key: "drive/org/file/v1", byte_size: 125 },
      ],
      [],
      [],
      [],
      deletedRows,
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, { metering });

    await expect(store.delete({ orgId, actorId, objectId })).resolves.toBe(true);

    expect(metering.records).toEqual([
      {
        orgId,
        event: {
          type: "storage.delta",
          quantity: -325,
          metadata: { bucket: "drive", byte_delta: -325 },
        },
      },
    ]);
  });

  it("does not fail finalized uploads when metering emission fails", async () => {
    const content = bytesOfSize(16, 2);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const errors: unknown[] = [];
    const metering = new RecordingMeteringClient({ reject: true });
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: 1_000, used: 0 })],
      [versionRow({ byteSize: 16, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(), {
      metering,
      onMeteringError(error) {
        errors.push(error);
      },
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 16,
        sha256,
        mimeType: "text/plain",
        content,
        metadata: {},
      }),
    ).resolves.toMatchObject({ objectId, byteSize: 16 });
    await Promise.resolve();

    expect(errors).toHaveLength(1);
  });

  it("blocks finalized uploads when the tenant storage_bytes_limit would be exceeded", async () => {
    const metering = new RecordingMeteringClient();
    const events = new RecordingEventBus();
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: 100, used: "95" })],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(), {
      events,
      metering,
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 10,
        sha256: "f".repeat(64),
        mimeType: "text/plain",
        metadata: {},
      }),
    ).rejects.toThrow(DriveStorageQuotaExceededError);

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[1]?.text).toContain("o.quotas ? 'storage_bytes_limit'");
    expect(recording.calls[1]?.text).toContain("p.quotas_default ? 'storage_bytes_limit'");
    expect(recording.calls[1]?.text).toContain("for update of o");
    expect(recording.calls[1]?.text).toContain("obj.kind in ('file', 'recording')");
    expect(recording.calls[1]?.text).toContain("from drive_versions v");
    expect(recording.calls[1]?.text).toContain("distinct on (stored.storage_key)");
    expect(recording.calls[1]?.text).toContain("metadata->>'status', 'ready'");
    expect(recording.calls[1]?.text).not.toContain("insert into drive_versions");
    expect(metering.records).toHaveLength(0);
    expect(events.records).toEqual([
      {
        subject: "quota.storage.exceeded",
        payload: {
          quota: "storage_bytes_limit",
          bucket: "drive",
          used_bytes: 95,
          limit_bytes: 100,
          byte_delta: 10,
          projected_bytes: 105,
        },
      },
    ]);
  });

  it("blocks prepared uploads when the tenant storage_bytes_limit would be exceeded", async () => {
    const metering = new RecordingMeteringClient();
    const events = new RecordingEventBus();
    const recording = createRecordingSql([[storageQuotaRow({ limit: 100, used: "95" })]]);
    const store = new PostgresDriveStore(recording.sql, undefined, { events, metering });

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "report.txt",
        mimeType: "text/plain",
        byteSize: 10,
      }),
    ).rejects.toThrow(DriveStorageQuotaExceededError);

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("o.quotas ? 'storage_bytes_limit'");
    expect(recording.calls[0]?.text).toContain("p.quotas_default ? 'storage_bytes_limit'");
    expect(recording.calls[0]?.text).toContain("for update of o");
    expect(recording.calls[0]?.text).toContain("or obj.upload_state = 'pending_upload'");
    expect(recording.calls[0]?.text).not.toContain("insert into objects");
    expect(metering.records).toHaveLength(0);
    expect(events.records).toEqual([
      {
        subject: "quota.storage.exceeded",
        payload: {
          quota: "storage_bytes_limit",
          bucket: "drive",
          used_bytes: 95,
          limit_bytes: 100,
          byte_delta: 10,
          projected_bytes: 105,
        },
      },
    ]);
  });

  it("treats JSON null storage_bytes_limit as unlimited", async () => {
    const content = bytesOfSize(512, 3);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const metering = new RecordingMeteringClient();
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: null, used: 10_000_000_000 })],
      [versionRow({ byteSize: 512, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(), {
      metering,
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 512,
        sha256,
        mimeType: "text/plain",
        content,
        metadata: {},
      }),
    ).resolves.toMatchObject({ objectId, byteSize: 512 });

    expect(recording.calls[2]?.text).toContain("insert into drive_versions");
    expect(metering.records[0]?.event).toMatchObject({
      type: "storage.delta",
      quantity: 512,
    });
  });

  it("treats JSON null storage_bytes_limit as unlimited during prepareUpload", async () => {
    const recording = createRecordingSql([
      [storageQuotaRow({ limit: null, used: 10_000_000_000 })],
      [objectRow({ byteSize: 512, metadata: { name: "report.txt", status: "pending_upload" } })],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "report.txt",
        mimeType: "text/plain",
        byteSize: 512,
      }),
    ).resolves.toMatchObject({ objectId, byteSize: 512 });

    expect(recording.calls[1]?.text).toContain("insert into objects");
  });

  it("routes inline object writes through the per-tenant storage resolver", async () => {
    const metering = new RecordingMeteringClient();
    const storage = new RecordingStorageClient();
    const content = new TextEncoder().encode("tenant scoped bytes");
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: 1_000, used: 0 })],
      [versionRow({ byteSize: content.byteLength, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, {
      metering,
      storageResolver: () => ({
        client: createPrefixedStorageClient(storage, "tenants/org-drive/"),
        managedBy: "helix-default",
        prefix: "tenants/org-drive/",
      }),
    });

    await store.finalizeUpload({
      orgId,
      actorId,
      objectId,
      byteSize: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      mimeType: "text/plain",
      content,
      metadata: {},
    });

    expect(storage.calls).toEqual([
      `put:tenants/org-drive/drive/${orgId}/${objectId}/v1/report.txt`,
    ]);
  });

  it("does not emit storage.delta when finalize validation fails", async () => {
    const metering = new RecordingMeteringClient();
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(), {
      metering,
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 3,
        sha256: "d".repeat(64),
        mimeType: "text/plain",
        content: new TextEncoder().encode("bad"),
        metadata: {},
      }),
    ).rejects.toThrow("SHA-256");

    expect(metering.records).toHaveLength(0);
  });

  it("rejects inline content finalization when no storage client is configured", async () => {
    const metering = new RecordingMeteringClient();
    const content = Buffer.from("orphan bytes");
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, { metering });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        content,
        metadata: {},
      }),
    ).rejects.toThrow("Drive upload content storage is not configured.");

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).not.toContain("insert into drive_versions");
    expect(metering.records).toHaveLength(0);
  });

  it("rejects tenant-prefixed physical storage keys during finalize", async () => {
    const storage = new RecordingStorageClient();
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, {
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: `tenants/${orgId}/`,
      }),
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 4,
        sha256: createHash("sha256").update("test").digest("hex"),
        mimeType: "text/plain",
        storageKey: `tenants/${orgId}/drive/${orgId}/${objectId}/v1/report.txt`,
        content: Buffer.from("test"),
        metadata: {},
      }),
    ).rejects.toThrow("Drive upload storageKey must be a logical Drive object key.");

    expect(storage.calls).toEqual([]);
  });

  it("accepts omitted storageKey for existing legacy logical rows", async () => {
    const storage = new RecordingStorageClient();
    const content = Buffer.from("legacy");
    const legacyStorageKey = "drive/test/doc";
    const recording = createRecordingSql([
      [
        objectRow({
          byteSize: 0,
          storageKey: legacyStorageKey,
          metadata: { name: "legacy.txt", status: "pending_upload" },
        }),
      ],
      [storageQuotaRow({ limit: 1_000, used: 0 })],
      [
        versionRow({
          byteSize: content.byteLength,
          versionNumber: 1,
          storageKey: legacyStorageKey,
        }),
      ],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, {
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        content,
        metadata: {},
      }),
    ).resolves.toMatchObject({ storageKey: legacyStorageKey });

    expect(storage.calls).toEqual([`put:${legacyStorageKey}`]);
  });

  it("does not emit storage.delta when hard delete does not delete a row", async () => {
    const metering = new RecordingMeteringClient();
    const notDeletedRows = Object.assign([], { count: 0 }) as unknown[];
    const recording = createRecordingSql([
      [objectRow({ byteSize: 200, hardDeleteReady: true })],
      [{ active_share_count: 0, pending_job_count: 0 }],
      [{ storage_key: "drive/org/file/current", byte_size: 200 }],
      [],
      [],
      [],
      notDeletedRows,
    ]);
    const store = new PostgresDriveStore(recording.sql, undefined, { metering });

    await expect(store.delete({ orgId, actorId, objectId })).resolves.toBe(false);

    expect(metering.records).toHaveLength(0);
  });

  it("deletes and marks an abandoned single-part upload", async () => {
    const storage = new RecordingStorageClient();
    const storageKey = `drive/${orgId}/${objectId}/v1/abandoned.bin`;
    const recording = createRecordingSql([
      [
        {
          id: objectId,
          org_id: orgId,
          storage_key: storageKey,
          kind: "single",
          upload_id: null,
        },
      ],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, storage);

    await expect(
      store.collectOrphans({
        olderThan: new Date("2026-05-23T00:00:00.000Z"),
        dryRun: false,
      }),
    ).resolves.toEqual({ candidates: 1, collected: 1 });

    expect(storage.calls).toEqual([`delete:${storageKey}`]);
    expect(recording.calls[0]?.text).toContain("then 'single'");
    expect(recording.calls[0]?.text).not.toContain("o.metadata->>'multipartUploadId' is not null");
    expect(recording.calls[1]?.text).toContain('"failureReason":"orphaned_upload"');
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
    const text = strings.join("?");
    if (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id")) {
      return { text, values };
    }
    if (text.includes("insert into drive_scan_jobs")) {
      calls.push({ text, values });
      return Promise.resolve([{ id: "scan-job-1" }]);
    }
    calls.push({ text, values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function objectRow(input: {
  readonly byteSize: number;
  readonly storageKey?: string;
  readonly metadata?: Record<string, unknown>;
  readonly hardDeleteReady?: boolean;
}): Record<string, unknown> {
  return {
    id: objectId,
    org_id: orgId,
    owner_actor_id: actorId,
    kind: "file",
    storage_key: input.storageKey ?? `drive/${orgId}/${objectId}/v1/report.txt`,
    mime_type: "text/plain",
    byte_size: input.byteSize,
    sha256: null,
    upload_state:
      input.metadata?.status === "pending_upload"
        ? "pending_upload"
        : input.hardDeleteReady === true
          ? "trashed"
          : "active",
    upload_declared_byte_size: null,
    upload_declared_sha256: null,
    metadata: input.metadata ?? { name: "report.txt", status: "ready" },
    deleted_at: input.hardDeleteReady === true ? new Date("2026-05-01T00:00:00.000Z") : null,
    trash_expires_at: input.hardDeleteReady === true ? new Date("2026-05-02T00:00:00.000Z") : null,
    created_at: new Date("2026-05-24T12:00:00.000Z"),
    updated_at: new Date("2026-05-24T12:00:00.000Z"),
  };
}

function versionRow(input: {
  readonly byteSize: number;
  readonly versionNumber: number;
  readonly storageKey?: string;
}): Record<string, unknown> {
  return {
    id: "version-1",
    org_id: orgId,
    object_id: objectId,
    version_number: input.versionNumber,
    storage_key: input.storageKey ?? `drive/${orgId}/${objectId}/v1/report.txt`,
    mime_type: "text/plain",
    byte_size: input.byteSize,
    sha256: "a".repeat(64),
    metadata: {},
    created_by_actor_id: actorId,
    created_at: new Date("2026-05-24T12:00:00.000Z"),
  };
}

function storageQuotaRow(input: {
  readonly limit: number | null;
  readonly used: string | number;
}): Record<string, unknown> {
  return {
    storage_bytes_limit: input.limit,
    storage_used_bytes: input.used,
  };
}

class RecordingMeteringClient implements MeteringClient {
  readonly records: {
    readonly orgId: string;
    readonly event: MeteringEvent;
    readonly trace?: TraceContext;
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

class RecordingEventBus implements EventBus {
  readonly records: { readonly subject: string; readonly payload: JsonValue }[] = [];

  async publish(subject: string, payload: JsonValue): Promise<void> {
    this.records.push({ subject, payload });
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    void subject;
    void handler;
    return async () => {};
  }
}

class RecordingStorageClient implements TenantStorageClient {
  readonly calls: string[] = [];
  readonly objects = new Map<string, Uint8Array>();

  async put(object: {
    readonly key: string;
    readonly body: Uint8Array | AsyncIterable<Uint8Array>;
  }): Promise<void> {
    this.calls.push(`put:${object.key}`);
    if (object.body instanceof Uint8Array) {
      this.objects.set(object.key, object.body);
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of object.body) chunks.push(chunk);
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.objects.set(object.key, body);
  }

  async get(key: string): Promise<{ readonly key: string; readonly body: Uint8Array } | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { key, body };
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
  }
}
