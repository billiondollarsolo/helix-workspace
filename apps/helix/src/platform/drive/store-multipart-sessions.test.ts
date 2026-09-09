import { createHash } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDriveStore, type DriveStorageClient } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherActorId = "33333333-3333-4333-8333-333333333333";
const body = new TextEncoder().encode("0123456789");
const digest = createHash("sha256").update(body).digest("hex");

interface MultipartState {
  object: Record<string, unknown> | undefined;
  session: Record<string, unknown> | undefined;
  version: Record<string, unknown> | undefined;
  inTransaction: boolean;
  failBind?: boolean;
}

class MultipartStorage implements DriveStorageClient {
  readonly calls: string[] = [];
  readonly objects = new Map<string, Uint8Array>();
  failPart: number | undefined;
  failAbort = false;

  constructor(private readonly state: MultipartState) {}

  private outsideTransaction(): void {
    expect(this.state.inTransaction).toBe(false);
  }

  async put(input: { key: string; body: Uint8Array }): Promise<void> {
    this.outsideTransaction();
    this.calls.push(`put:${input.key}`);
    this.objects.set(input.key, input.body);
  }

  async get(key: string): Promise<{ key: string; body: Uint8Array } | null> {
    this.outsideTransaction();
    this.calls.push(`get:${key}`);
    const value = this.objects.get(key);
    return value === undefined ? null : { key, body: value };
  }

  async delete(key: string): Promise<void> {
    this.outsideTransaction();
    this.calls.push(`delete:${key}`);
    this.objects.delete(key);
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    this.outsideTransaction();
    this.calls.push(`create:${key}`);
    return { uploadId: "upload-1" };
  }

  async presignUploadPart(_key: string, _uploadId: string, partNumber: number): Promise<string> {
    this.outsideTransaction();
    this.calls.push(`presign:${String(partNumber)}`);
    if (this.failPart === partNumber) throw new Error("part presign failed");
    return `https://storage.invalid/part/${String(partNumber)}`;
  }

  async completeMultipartUpload(key: string): Promise<void> {
    this.outsideTransaction();
    this.calls.push(`complete:${key}`);
    this.objects.set(key, body);
  }

  async abortMultipartUpload(key: string): Promise<void> {
    this.outsideTransaction();
    this.calls.push(`abort:${key}`);
    if (this.failAbort) throw new Error("multipart abort failed");
  }
}

function createMultipartSql(state: MultipartState): postgres.Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (
      !/^(select|with|update|insert|delete|set)\b/iu.test(text.trimStart()) &&
      text.includes("helix_drive_effective_role")
    ) {
      return { text, values };
    }
    if (text.includes("set_config('helix.org_id'")) return Promise.resolve([]);
    if (text.includes("helix_reconcile_storage_usage")) return Promise.resolve([]);
    if (
      text.includes("helix_reserve_drive_storage") ||
      text.includes("helix_commit_storage_usage")
    ) {
      return Promise.resolve([
        {
          accepted: true,
          used_bytes: "0",
          reserved_bytes: "0",
          limit_bytes: null,
          projected_bytes: typeof values[2] === "number" ? String(values[2]) : "0",
        },
      ]);
    }
    if (text.includes("select id from orgs")) {
      return Promise.resolve(values.includes(orgId) ? [] : [{ id: orgId }]);
    }
    if (text.includes("storage_bytes_limit")) {
      return Promise.resolve([{ storage_bytes_limit: null, storage_used_bytes: 0 }]);
    }
    if (text.includes("insert into objects")) {
      state.object = {
        id: values[0],
        org_id: values[1],
        owner_actor_id: values[2],
        kind: "file",
        storage_key: values[3],
        mime_type: values[4],
        byte_size: values[5],
        sha256: values[6],
        metadata: values[7],
        deleted_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      return Promise.resolve([state.object]);
    }
    if (text.includes("insert into drive_multipart_sessions")) {
      state.session = {
        id: "session-1",
        org_id: values[0],
        object_id: values[1],
        actor_id: values[2],
        storage_key: values[3],
        upload_id: null,
        status: "provisioning",
        byte_size: values[4],
        part_size: values[5],
        part_count: values[6],
        expires_at: values[7],
        next_attempt_at: new Date(),
        lease_expires_at: null,
        completion_hash: null,
        version_id: null,
        last_error: null,
      };
      return Promise.resolve([]);
    }
    if (text.includes("set upload_id =")) {
      if (text.includes("status = 'aborting'")) {
        if (state.session !== undefined) {
          state.session.upload_id = values[0];
          state.session.status = "aborting";
          state.session.lease_expires_at = new Date();
        }
        return Promise.resolve([]);
      }
      if (state.failBind === true) throw new Error("session bind failed");
      if (state.session !== undefined) state.session.upload_id = values[0];
      return Promise.resolve([{ id: "session-1" }]);
    }
    if (text.includes("set status = 'pending', next_attempt_at = expires_at")) {
      if (state.session !== undefined) state.session.status = "pending";
      return Promise.resolve([{ id: "session-1" }]);
    }
    if (text.includes("select * from drive_multipart_sessions")) {
      return Promise.resolve(state.session === undefined ? [] : [state.session]);
    }
    if (text.includes("set status = 'completing'")) {
      if (state.session === undefined) return Promise.resolve([]);
      state.session.status = "completing";
      state.session.completion_hash = values[0];
      state.session.lease_expires_at = values.find((value) => value instanceof Date) ?? null;
      return Promise.resolve([{ ...state.session }]);
    }
    if (text.includes("set status = 'uploaded'")) {
      if (state.session !== undefined) {
        state.session.status = "uploaded";
        state.session.lease_expires_at = null;
      }
      return Promise.resolve([]);
    }
    if (text.includes("set status = 'completed'")) {
      if (state.session !== undefined) {
        state.session.status = "completed";
        state.session.version_id = values.find((value) => value === state.version?.id) ?? null;
      }
      return Promise.resolve([]);
    }
    if (text.includes("select * from drive_versions")) {
      return Promise.resolve(state.version === undefined ? [] : [state.version]);
    }
    if (
      text.includes("select *") &&
      text.includes("from objects") &&
      text.includes("kind in ('file', 'recording')")
    ) {
      return Promise.resolve(state.object === undefined ? [] : [state.object]);
    }
    if (text.includes("select role") && text.includes("from permissions")) {
      return Promise.resolve([{ role: "editor" }]);
    }
    if (text.includes("+ 1 as version_number")) return Promise.resolve([{ version_number: 1 }]);
    if (text.includes("update objects") && text.includes("returning *")) {
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && "scanToken" in value,
      );
      if (state.object !== undefined && metadata !== undefined) {
        state.object = { ...state.object, metadata };
        return Promise.resolve([state.object]);
      }
      return Promise.resolve([]);
    }
    if (text.includes("insert into drive_versions")) {
      state.version = {
        id: "44444444-4444-4444-8444-444444444444",
        org_id: values[0],
        object_id: values[1],
        version_number: values[2],
        storage_key: values[3],
        mime_type: values[4],
        byte_size: values[5],
        sha256: values[6],
        metadata: values[7],
        created_by_actor_id: values[8],
        created_at: new Date(),
      };
      return Promise.resolve([state.version]);
    }
    if (text.includes("update objects") && text.includes("storage_key")) {
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>).status === "ready",
      );
      if (state.object !== undefined) {
        state.object = {
          ...state.object,
          storage_key: values[0],
          mime_type: values[1],
          byte_size: values[2],
          sha256: values[3],
          metadata: metadata ?? state.object.metadata,
        };
      }
      return Promise.resolve([{ id: state.object?.id }]);
    }
    if (text.includes("with candidates as materialized")) {
      if (state.session === undefined) return Promise.resolve([]);
      const prior = state.session.status;
      state.session.status = "aborting";
      return Promise.resolve([{ ...state.session, prior_status: prior }]);
    }
    if (text.includes("with candidates as") && text.includes("upload_expiring")) {
      if (state.object === undefined) return Promise.resolve([]);
      const metadata = state.object.metadata as Record<string, unknown>;
      if (new Date(String(metadata.uploadExpiresAt)).getTime() > Date.now()) {
        return Promise.resolve([]);
      }
      state.object = {
        ...state.object,
        metadata: { ...metadata, status: "upload_expiring" },
      };
      return Promise.resolve([state.object]);
    }
    if (text.includes("delete from objects")) {
      state.object = undefined;
      return Promise.resolve([]);
    }
    if (text.includes("delete from drive_multipart_sessions")) {
      state.session = undefined;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
      state.inTransaction = true;
      try {
        return await callback(sql as unknown as postgres.TransactionSql);
      } finally {
        state.inTransaction = false;
      }
    },
  });
  return sql as unknown as postgres.Sql;
}

function createStore(
  state: MultipartState,
  storage: MultipartStorage,
  multipartThresholdBytes = 4,
): PostgresDriveStore {
  return new PostgresDriveStore(createMultipartSql(state), undefined, {
    multipartThresholdBytes,
    multipartPartSizeBytes: 4,
    multipartSessionTtlMs: 60_000,
    storageResolver: () => {
      expect(state.inTransaction).toBe(false);
      return { client: storage, managedBy: "helix-default", prefix: "" };
    },
  });
}

describe("PostgresDriveStore multipart sessions", () => {
  it("binds plan and actor, rejects tampering/expiry, and completes idempotently", async () => {
    const state: MultipartState = {
      object: undefined,
      session: undefined,
      version: undefined,
      inTransaction: false,
    };
    const storage = new MultipartStorage(state);
    const store = createStore(state, storage);
    const prepared = await store.prepareUpload({
      orgId,
      actorId,
      name: "large.bin",
      mimeType: "application/octet-stream",
      byteSize: body.byteLength,
      sha256: digest,
    });

    expect(prepared.multipart).toMatchObject({ uploadId: "upload-1", partCount: 3, partSize: 4 });
    expect(new Date(prepared.multipart?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(state.session).toMatchObject({ actor_id: actorId, status: "pending", part_count: 3 });

    if (state.object !== undefined) state.object.owner_actor_id = otherActorId;
    await expect(
      store.completeMultipartUpload({
        orgId,
        actorId: otherActorId,
        objectId: prepared.objectId,
        uploadId: "upload-1",
        parts: [
          { partNumber: 1, etag: "a" },
          { partNumber: 2, etag: "b" },
          { partNumber: 3, etag: "c" },
        ],
        byteSize: body.byteLength,
        sha256: digest,
      }),
    ).rejects.toThrow("actor who prepared");
    if (state.object !== undefined) state.object.owner_actor_id = actorId;

    await expect(
      store.completeMultipartUpload({
        orgId,
        actorId,
        objectId: prepared.objectId,
        uploadId: "upload-1",
        parts: [
          { partNumber: 1, etag: "a" },
          { partNumber: 2, etag: "b" },
        ],
        byteSize: body.byteLength,
        sha256: digest,
      }),
    ).rejects.toThrow("Expected 3 parts");

    if (state.session !== undefined) state.session.expires_at = new Date(0);
    const parts = [
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
      { partNumber: 3, etag: "c" },
    ];
    await expect(
      store.completeMultipartUpload({
        orgId,
        actorId,
        objectId: prepared.objectId,
        uploadId: "upload-1",
        parts,
        byteSize: body.byteLength,
        sha256: digest,
      }),
    ).rejects.toThrow("expired");
    if (state.session !== undefined) state.session.expires_at = new Date(Date.now() + 60_000);

    const first = await store.completeMultipartUpload({
      orgId,
      actorId,
      objectId: prepared.objectId,
      uploadId: "upload-1",
      parts,
      byteSize: body.byteLength,
      sha256: digest,
    });
    const replay = await store.completeMultipartUpload({
      orgId,
      actorId,
      objectId: prepared.objectId,
      uploadId: "upload-1",
      parts,
      byteSize: body.byteLength,
      sha256: digest,
    });
    expect(replay.id).toBe(first.id);
    expect(storage.calls.filter((call) => call.startsWith("complete:"))).toHaveLength(1);
    expect(state.session).toMatchObject({ status: "completed", version_id: first.id });

    await expect(
      store.completeMultipartUpload({
        orgId,
        actorId,
        objectId: prepared.objectId,
        uploadId: "upload-1",
        parts: [
          { partNumber: 1, etag: "changed" },
          { partNumber: 2, etag: "b" },
          { partNumber: 3, etag: "c" },
        ],
        byteSize: body.byteLength,
        sha256: digest,
      }),
    ).rejects.toThrow("does not match the first attempt");
  });

  it("aborts a partially provisioned upload and removes its pending database rows", async () => {
    const state: MultipartState = {
      object: undefined,
      session: undefined,
      version: undefined,
      inTransaction: false,
    };
    const storage = new MultipartStorage(state);
    storage.failPart = 2;
    const store = createStore(state, storage);

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "large.bin",
        mimeType: "application/octet-stream",
        byteSize: body.byteLength,
      }),
    ).rejects.toThrow("part presign failed");
    expect(storage.calls.some((call) => call.startsWith("abort:"))).toBe(true);
    expect(state.object).toBeUndefined();
    expect(state.session).toBeUndefined();
  });

  it("durably schedules abort when binding and immediate provider compensation both fail", async () => {
    const state: MultipartState = {
      object: undefined,
      session: undefined,
      version: undefined,
      inTransaction: false,
      failBind: true,
    };
    const storage = new MultipartStorage(state);
    storage.failAbort = true;
    const store = createStore(state, storage);

    await expect(
      store.prepareUpload({
        orgId,
        actorId,
        name: "large.bin",
        mimeType: "application/octet-stream",
        byteSize: body.byteLength,
      }),
    ).rejects.toThrow("session bind failed");
    expect(storage.calls.some((call) => call.startsWith("abort:"))).toBe(true);
    expect(state.object).toBeDefined();
    expect(state.session).toMatchObject({
      upload_id: "upload-1",
      status: "aborting",
      lease_expires_at: expect.any(Date),
    });
  });

  it("leases and sweeps an expired abandoned session, including provider state and bytes", async () => {
    const state: MultipartState = {
      object: undefined,
      session: undefined,
      version: undefined,
      inTransaction: false,
    };
    const storage = new MultipartStorage(state);
    const store = createStore(state, storage);
    const prepared = await store.prepareUpload({
      orgId,
      actorId,
      name: "large.bin",
      mimeType: "application/octet-stream",
      byteSize: body.byteLength,
    });
    storage.objects.set(prepared.storageKey, body);
    if (state.session !== undefined) state.session.expires_at = new Date(0);

    await expect(
      store.runVirusScanRetryBatch({
        limit: 1,
        leaseMs: 30_000,
        now: new Date(),
        includeVirusScans: false,
      }),
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(storage.calls).toEqual(
      expect.arrayContaining([`abort:${prepared.storageKey}`, `delete:${prepared.storageKey}`]),
    );
    expect(storage.objects.has(prepared.storageKey)).toBe(false);
    expect(state.object).toBeUndefined();
    expect(state.session).toBeUndefined();
  });

  it("sweeps an abandoned single-part reservation and any uploaded bytes", async () => {
    const state: MultipartState = {
      object: undefined,
      session: undefined,
      version: undefined,
      inTransaction: false,
    };
    const storage = new MultipartStorage(state);
    const store = createStore(state, storage, 1_000);
    const prepared = await store.prepareUpload({
      orgId,
      actorId,
      name: "small.bin",
      mimeType: "application/octet-stream",
      byteSize: body.byteLength,
    });
    storage.objects.set(prepared.storageKey, body);
    if (state.object !== undefined) {
      state.object.metadata = {
        ...(state.object.metadata as Record<string, unknown>),
        uploadExpiresAt: new Date(0).toISOString(),
      };
    }

    await expect(
      store.runVirusScanRetryBatch({
        limit: 1,
        leaseMs: 30_000,
        now: new Date(),
        includeVirusScans: false,
      }),
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(storage.objects.has(prepared.storageKey)).toBe(false);
    expect(state.object).toBeUndefined();
  });
});
