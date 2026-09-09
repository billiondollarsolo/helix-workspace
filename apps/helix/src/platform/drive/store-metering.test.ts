import { createHash } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import { DriveStorageQuotaExceededError, PostgresDriveStore } from "./store.js";
import { createPrefixedStorageClient, type TenantStorageClient } from "../storage/index.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";

describe("PostgresDriveStore metering", () => {
  it("commits positive storage usage after a prepared upload is finalized", async () => {
    const operations: { readonly operation: string; readonly status: string }[] = [];
    const units: { readonly measure: string; readonly value?: number }[] = [];
    const content = Buffer.alloc(128, 1);
    const recording = createRecordingSql([
      [objectRow({ byteSize: 128, metadata: { name: "report.txt", status: "pending_upload" } })],
      [versionRow({ byteSize: 128, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(content), {
      metrics: {
        recordOperationalEvent: (event) => operations.push(event),
        addOperationalUnits: (event) => units.push(event),
      },
    });

    await store.finalizeUpload({
      orgId,
      actorId,
      objectId,
      byteSize: 128,
      sha256: createHash("sha256").update(content).digest("hex"),
      mimeType: "text/plain",
      metadata: {},
    });

    const commit = recording.calls.find((call) => call.text.includes("helix_commit_storage_usage"));
    expect(commit?.values).toEqual([orgId, objectId, 128, "drive"]);
    expect(operations).toEqual([
      expect.objectContaining({ operation: "virus_scan", status: "success" }),
      expect.objectContaining({ operation: "finalize", status: "success" }),
    ]);
    expect(units).toEqual([expect.objectContaining({ measure: "uploaded_bytes", value: 128 })]);
  });

  it("commits replacement deltas for finalized overwrites of the current storage key", async () => {
    const content = Buffer.alloc(150, 2);
    const recording = createRecordingSql([
      [objectRow({ byteSize: 200, metadata: { name: "report.txt", status: "ready" } })],
      [versionRow({ byteSize: 150, versionNumber: 2 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(content));

    await store.finalizeUpload({
      orgId,
      actorId,
      objectId,
      byteSize: 150,
      sha256: createHash("sha256").update(content).digest("hex"),
      mimeType: "text/plain",
      metadata: {},
    });

    expect(
      recording.calls.find((call) => call.text.includes("helix_commit_storage_usage"))?.values,
    ).toEqual([orgId, objectId, -50, "drive"]);
  });

  it("commits negative storage usage for hard deletes using distinct stored keys", async () => {
    const deletedRows = Object.assign([], { count: 1 }) as unknown[];
    const recording = createRecordingSql([
      [
        objectRow({
          byteSize: 200,
          storageKey: "drive/org/file/current",
          deletedAt: new Date("2000-01-01T00:00:00.000Z"),
          trashPurgeAfter: new Date("2000-02-01T00:00:00.000Z"),
        }),
      ],
      [],
      [],
      [
        { storage_key: "drive/org/file/current", byte_size: 200 },
        { storage_key: "drive/org/file/v1", byte_size: 125 },
      ],
      [],
      [],
      deletedRows,
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.delete({ orgId, actorId, objectId })).resolves.toBe(true);

    expect(
      recording.calls.find((call) => call.text.includes("helix_commit_storage_usage"))?.values,
    ).toEqual([orgId, objectId, -325, "drive"]);
  });

  it("writes storage usage inside the finalize transaction", async () => {
    const content = Buffer.alloc(16, 3);
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: 1_000, used: 0 })],
      [versionRow({ byteSize: 16, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(content));

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 16,
        sha256: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        metadata: {},
      }),
    ).resolves.toMatchObject({ objectId, byteSize: 16 });
    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      true,
    );
  });

  it("blocks finalized uploads when the tenant storage_bytes_limit would be exceeded", async () => {
    const events = new RecordingEventBus();
    const content = Buffer.alloc(10, 4);
    const operations: { readonly operation: string; readonly status: string }[] = [];
    const recording = createRecordingSql(
      [
        [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
        [versionRow({ byteSize: 10, versionNumber: 1 })],
      ],
      { quotaDecision: quotaDecision({ accepted: false, limit: 100, used: 95, projected: 105 }) },
    );
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(content), {
      events,
      metrics: {
        recordOperationalEvent: (event) => operations.push(event),
        addOperationalUnits: () => undefined,
      },
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 10,
        sha256: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        metadata: {},
      }),
    ).rejects.toThrow(DriveStorageQuotaExceededError);

    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      true,
    );
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "quota", status: "blocked" }),
        expect.objectContaining({ operation: "finalize", status: "error" }),
      ]),
    );
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
    const events = new RecordingEventBus();
    const recording = createRecordingSql(
      [[objectRow({ byteSize: 10, metadata: { name: "report.txt", status: "pending_upload" } })]],
      { quotaDecision: quotaDecision({ accepted: false, limit: 100, used: 95, projected: 105 }) },
    );
    const store = new PostgresDriveStore(recording.sql, undefined, { events });

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "report.txt",
        mimeType: "text/plain",
        byteSize: 10,
      }),
    ).rejects.toThrow(DriveStorageQuotaExceededError);

    expect(recording.calls.some((call) => call.text.includes("insert into objects"))).toBe(true);
    expect(recording.calls.some((call) => call.text.includes("helix_reserve_drive_storage"))).toBe(
      true,
    );
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

  it("fails closed when quota accounting cannot resolve the tenant", async () => {
    const store = new PostgresDriveStore(
      createRecordingSql(
        [[objectRow({ byteSize: 10, metadata: { name: "report.txt", status: "pending_upload" } })]],
        { quotaDecision: null },
      ).sql,
    );

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "report.txt",
        mimeType: "text/plain",
        byteSize: 10,
      }),
    ).rejects.toThrow("Unknown Drive tenant");
  });

  it("treats JSON null storage_bytes_limit as unlimited", async () => {
    const content = Buffer.alloc(512, 5);
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
      [storageQuotaRow({ limit: null, used: 10_000_000_000 })],
      [versionRow({ byteSize: 512, versionNumber: 1 })],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresDriveStore(recording.sql, new RecordingStorageClient(content));

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId,
        byteSize: 512,
        sha256: createHash("sha256").update(content).digest("hex"),
        mimeType: "text/plain",
        metadata: {},
      }),
    ).resolves.toMatchObject({ objectId, byteSize: 512 });

    expect(recording.calls.some((call) => call.text.includes("insert into drive_versions"))).toBe(
      true,
    );
    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      true,
    );
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

    expect(recording.calls[0]?.text).toContain("insert into objects");
  });

  it("routes inline object writes through the per-tenant storage resolver", async () => {
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
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
    ]);
    const store = new PostgresDriveStore(recording.sql);

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
    ).rejects.toThrow("sha256");

    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      false,
    );
  });

  it("does not fall through an authoritative tenant resolver to default storage", async () => {
    const content = Buffer.from("orphan bytes");
    const storage = new RecordingStorageClient(content);
    const recording = createRecordingSql([
      [objectRow({ byteSize: 0, metadata: { name: "report.txt", status: "pending_upload" } })],
    ]);
    const store = new PostgresDriveStore(recording.sql, storage, {
      storageResolver: async () => undefined,
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
    ).rejects.toThrow("Drive upload content storage is not configured.");

    expect(recording.calls.some((call) => call.text.includes("insert into drive_versions"))).toBe(
      false,
    );
    expect(storage.calls).toEqual([]);
  });

  it("uses the prepared logical storage key during finalize", async () => {
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
    const notDeletedRows = Object.assign([], { count: 0 }) as unknown[];
    const recording = createRecordingSql([
      [
        objectRow({
          byteSize: 200,
          deletedAt: new Date("2000-01-01T00:00:00.000Z"),
          trashPurgeAfter: new Date("2000-02-01T00:00:00.000Z"),
        }),
      ],
      [],
      [],
      [{ storage_key: "drive/org/file/current", byte_size: 200 }],
      [],
      [],
      [],
      notDeletedRows,
    ]);
    const store = new PostgresDriveStore(recording.sql);

    await expect(store.delete({ orgId, actorId, objectId })).resolves.toBe(false);

    expect(recording.calls.some((call) => call.text.includes("helix_commit_storage_usage"))).toBe(
      false,
    );
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(
  responses: readonly unknown[],
  options: { readonly quotaDecision?: Record<string, unknown> | null } = {},
): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  let currentObject: Record<string, unknown> | undefined;
  const nextResponse = (): unknown => {
    while (callIndex < responses.length) {
      const response = responses[callIndex++] ?? [];
      if (
        Array.isArray(response) &&
        typeof response[0] === "object" &&
        response[0] !== null &&
        "storage_bytes_limit" in response[0]
      ) {
        continue;
      }
      return response;
    }
    return [];
  };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (
      !/^(select|with|update|insert|delete|set)\b/iu.test(text.trimStart()) &&
      text.includes("helix_drive_effective_role")
    ) {
      return { text, values };
    }
    if (text.includes("set_config('helix.org_id'")) {
      return Promise.resolve([{ set_config: values[0] }]);
    }
    calls.push({ text, values });
    if (
      text.includes("helix_reserve_drive_storage") ||
      text.includes("helix_commit_storage_usage")
    ) {
      if (options.quotaDecision === null) return Promise.resolve([]);
      return Promise.resolve([
        options.quotaDecision ??
          quotaDecision({ accepted: true, limit: null, used: 0, projected: Number(values[2]) }),
      ]);
    }
    if (
      text.includes("select *") &&
      text.includes("from objects") &&
      text.includes("kind in ('file', 'recording')")
    ) {
      if (currentObject !== undefined) return Promise.resolve([currentObject]);
      const response = nextResponse();
      if (Array.isArray(response) && response[0] !== undefined) {
        currentObject = response[0] as Record<string, unknown>;
      }
      return Promise.resolve(response);
    }
    if (text.includes("+ 1 as version_number") && text.includes("from drive_versions")) {
      return Promise.resolve([{ version_number: 1 }]);
    }
    if (text.includes("update objects") && text.includes("returning *")) {
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && "scanToken" in value,
      );
      if (currentObject !== undefined && metadata !== undefined) {
        currentObject = { ...currentObject, metadata };
        return Promise.resolve([currentObject]);
      }
    }
    if (text.includes("update objects") && text.includes("metadata->>'scanToken'")) {
      if (text.includes("storage_key")) nextResponse();
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && "status" in value,
      );
      if (currentObject !== undefined && metadata !== undefined) {
        currentObject = { ...currentObject, metadata };
      }
      return Promise.resolve([{ id: objectId }]);
    }
    return Promise.resolve(nextResponse());
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
  readonly deletedAt?: Date;
  readonly trashPurgeAfter?: Date;
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
    metadata: input.metadata ?? { name: "report.txt", status: "ready" },
    deleted_at: input.deletedAt ?? null,
    trash_purge_after: input.trashPurgeAfter ?? null,
    retain_until: null,
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

function quotaDecision(input: {
  readonly accepted: boolean;
  readonly limit: number | null;
  readonly used: number;
  readonly projected: number;
}): Record<string, unknown> {
  return {
    accepted: input.accepted,
    used_bytes: String(input.used),
    reserved_bytes: "0",
    limit_bytes: input.limit === null ? null : String(input.limit),
    projected_bytes: String(input.projected),
  };
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

  constructor(private readonly body: Uint8Array = new Uint8Array([1])) {}

  async put(object: { readonly key: string }): Promise<void> {
    this.calls.push(`put:${object.key}`);
  }

  async get(key: string): Promise<{ readonly key: string; readonly body: Uint8Array } | null> {
    this.calls.push(`get:${key}`);
    return { key, body: this.body };
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
  }
}
