/**
 * Store-level content-addressed dedup tests.
 * Drives the real PostgresDriveStore.finalizeUpload / delete paths with a
 * recording SQL + in-memory storage client — no live Postgres required.
 */
import type postgres from "postgres";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { driveBlobKey } from "./core/storage-key.js";
import { PostgresDriveStore, type DriveStorageClient } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectIdA = "33333333-3333-4333-8333-333333333333";
const objectIdB = "44444444-4444-4444-8444-444444444444";
const reservedKeyA = `drive/${orgId}/${objectIdA}/v1/a.bin`;
const reservedKeyB = `drive/${orgId}/${objectIdB}/v1/b.bin`;
const content = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const sha256 = createHash("sha256").update(content).digest("hex");
const blobKey = driveBlobKey(orgId, sha256);

function objectRow(objectId: string, storageKey: string, sha: string | null = null) {
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    id: objectId,
    org_id: orgId,
    owner_actor_id: actorId,
    kind: "file",
    storage_key: storageKey,
    mime_type: "application/octet-stream",
    byte_size: content.byteLength,
    sha256: sha,
    metadata: { name: "a.bin", folderId: null, status: "pending_upload" },
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

function versionRow(objectId: string, storageKey: string, versionNumber: number) {
  return {
    id: `ver-${objectId}-${String(versionNumber)}`,
    org_id: orgId,
    object_id: objectId,
    version_number: versionNumber,
    storage_key: storageKey,
    mime_type: "application/octet-stream",
    byte_size: content.byteLength,
    sha256,
    metadata: {},
    created_by_actor_id: actorId,
    created_at: new Date("2026-07-18T00:00:00.000Z"),
  };
}

class MemoryStorage implements DriveStorageClient {
  readonly puts: Array<{ key: string; body: Uint8Array }> = [];
  readonly deletes: string[] = [];
  readonly objects = new Map<string, Uint8Array>();

  async put(object: { key: string; body: Uint8Array | AsyncIterable<Uint8Array> }): Promise<void> {
    const body =
      object.body instanceof Uint8Array
        ? object.body
        : new Uint8Array(await collectAsync(object.body));
    this.puts.push({ key: object.key, body });
    this.objects.set(object.key, body);
  }

  async get(key: string): Promise<{ key: string; body: Uint8Array } | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { key, body };
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

async function collectAsync(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Stateful fake SQL that models:
 * - requireObjectAccess (select objects)
 * - drive_blobs upsert/refcount
 * - drive_versions insert
 * - objects update
 * - delete path version list + blob refcount decrement
 */
function createDedupSql(state: {
  objects: Map<string, ReturnType<typeof objectRow>>;
  blobs: Map<string, { sha256: string; storageKey: string; refcount: number; byteSize: number }>;
  versions: Array<ReturnType<typeof versionRow>>;
}) {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id")) {
      return { text, values };
    }

    // requireObjectAccess
    if (text.includes("from objects") && text.includes("kind in")) {
      const objectId = values.find((v) => typeof v === "string" && state.objects.has(v)) as
        | string
        | undefined;
      if (objectId === undefined) return Promise.resolve([]);
      const row = state.objects.get(objectId);
      return Promise.resolve(row === undefined ? [] : [row]);
    }

    // quota select — unlimited
    if (text.includes("storage_bytes_limit") || text.includes("storage_used")) {
      return Promise.resolve([{ storage_bytes_limit: null, storage_used_bytes: 0 }]);
    }

    // drive_blobs upsert
    if (text.includes("insert into drive_blobs")) {
      const sha = values.find((v) => typeof v === "string" && v.length === 64) as string;
      const key = values.find(
        (value): value is string => typeof value === "string" && value.includes("/blobs/"),
      );
      if (key === undefined) throw new Error("Expected a blob storage key");
      const existing = state.blobs.get(sha);
      if (existing === undefined) {
        state.blobs.set(sha, {
          sha256: sha,
          storageKey: key,
          refcount: 1,
          byteSize: content.byteLength,
        });
        return Promise.resolve([{ inserted: true }]);
      }
      existing.refcount += 1;
      return Promise.resolve([{ inserted: false }]);
    }

    // drive_blobs decrement
    if (text.includes("update drive_blobs") && text.includes("refcount = refcount - 1")) {
      const key = values.find(
        (value): value is string => typeof value === "string" && value.includes("/blobs/"),
      );
      if (key === undefined) return Promise.resolve([]);
      for (const blob of state.blobs.values()) {
        if (blob.storageKey === key) {
          blob.refcount -= 1;
          return Promise.resolve([{ refcount: blob.refcount }]);
        }
      }
      return Promise.resolve([]);
    }

    // drive_blobs delete at zero
    if (text.includes("delete from drive_blobs")) {
      const key = values.find(
        (value): value is string => typeof value === "string" && value.includes("/blobs/"),
      );
      if (key !== undefined) {
        for (const [sha, blob] of state.blobs) {
          if (blob.storageKey === key && blob.refcount <= 0) {
            state.blobs.delete(sha);
          }
        }
      }
      return Promise.resolve([]);
    }

    // version insert
    if (text.includes("insert into drive_versions")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string;
      const storageKey = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("drive/"),
      );
      if (storageKey === undefined) throw new Error("Expected a version storage key");
      const ver = versionRow(objectId, storageKey, state.versions.length + 1);
      state.versions.push(ver);
      return Promise.resolve([ver]);
    }

    // objects update after finalize
    if (text.includes("update objects") && text.includes("storage_key")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string | undefined;
      const storageKey = values.find(
        (value): value is string => typeof value === "string" && value.includes("/blobs/"),
      );
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as Record<string, unknown>).status === "string",
      );
      if (objectId !== undefined && storageKey !== undefined) {
        const prev = state.objects.get(objectId);
        if (prev !== undefined) {
          state.objects.set(objectId, {
            ...prev,
            storage_key: storageKey,
            sha256,
            byte_size: content.byteLength,
            metadata:
              metadata === undefined
                ? { ...prev.metadata, status: "ready" }
                : (metadata as typeof prev.metadata),
          });
        }
      }
      return Promise.resolve([]);
    }

    // activity / outbox
    if (text.includes("from activity") || text.includes("insert into activity")) {
      return Promise.resolve([{ hash: "0".repeat(64) }]);
    }
    if (text.includes("insert into outbox") || text.includes("from outbox")) {
      return Promise.resolve([]);
    }

    // list versions for delete
    if (text.includes("select storage_key, byte_size from drive_versions")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string | undefined;
      return Promise.resolve(
        state.versions
          .filter((v) => v.object_id === objectId)
          .map((v) => ({ storage_key: v.storage_key, byte_size: v.byte_size })),
      );
    }

    // delete versions / permissions / objects
    if (text.includes("delete from permissions")) return Promise.resolve({ count: 1 });
    if (text.includes("delete from drive_versions")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string | undefined;
      state.versions = state.versions.filter((v) => v.object_id !== objectId);
      return Promise.resolve({ count: 1 });
    }
    if (text.includes("delete from objects")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string | undefined;
      if (objectId !== undefined) state.objects.delete(objectId);
      return Promise.resolve({ count: 1 });
    }

    // metadata app lookup for trash-sync
    if (text.includes("metadata->>'app'")) {
      return Promise.resolve([{ app: null }]);
    }

    // max version for various selects
    if (text.includes("max(version_number)")) {
      return Promise.resolve([{ version_number: state.versions.length }]);
    }

    return Promise.resolve([]);
  };

  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;

  return sql;
}

describe("PostgresDriveStore content-addressed dedup", () => {
  it("uploads identical bytes twice with one storage write and refcount=2", async () => {
    const state = {
      objects: new Map([
        [objectIdA, objectRow(objectIdA, reservedKeyA)],
        [objectIdB, objectRow(objectIdB, reservedKeyB)],
      ]),
      blobs: new Map<
        string,
        { sha256: string; storageKey: string; refcount: number; byteSize: number }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
    };
    const storage = new MemoryStorage();
    // Simulate presigned PUT already writing to reserved keys (no inline content).
    storage.objects.set(reservedKeyA, content);
    storage.objects.set(reservedKeyB, content);

    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
    });

    // Finalize A without inline content — must copy reserved → blob on first ref.
    const v1 = await store.finalizeUpload({
      orgId,
      actorId,
      objectId: objectIdA,
      byteSize: content.byteLength,
      sha256,
      storageKey: reservedKeyA,
    });
    expect(v1.storageKey).toBe(blobKey);
    expect(storage.puts.map((p) => p.key)).toEqual([blobKey]);
    expect(state.blobs.get(sha256)?.refcount).toBe(1);
    expect(storage.objects.has(blobKey)).toBe(true);

    // Finalize B with same bytes — second ref, no additional storage put.
    const putsBefore = storage.puts.length;
    const v2 = await store.finalizeUpload({
      orgId,
      actorId,
      objectId: objectIdB,
      byteSize: content.byteLength,
      sha256,
      storageKey: reservedKeyB,
    });
    expect(v2.storageKey).toBe(blobKey);
    expect(storage.puts.length).toBe(putsBefore);
    expect(state.blobs.get(sha256)?.refcount).toBe(2);
  });

  it("delete decrements refcount and only removes storage at zero", async () => {
    const state = {
      objects: new Map([
        [
          objectIdA,
          {
            ...objectRow(objectIdA, blobKey, sha256),
            metadata: { name: "a.bin", folderId: null, status: "ready" },
          },
        ],
        [
          objectIdB,
          {
            ...objectRow(objectIdB, blobKey, sha256),
            metadata: { name: "b.bin", folderId: null, status: "ready" },
          },
        ],
      ]),
      blobs: new Map([
        [sha256, { sha256, storageKey: blobKey, refcount: 2, byteSize: content.byteLength }],
      ]),
      versions: [versionRow(objectIdA, blobKey, 1), versionRow(objectIdB, blobKey, 1)],
    };
    const storage = new MemoryStorage();
    storage.objects.set(blobKey, content);

    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
    });

    await store.delete({ orgId, actorId, objectId: objectIdA });
    expect(state.blobs.get(sha256)?.refcount).toBe(1);
    expect(storage.deletes).toEqual([]);
    expect(storage.objects.has(blobKey)).toBe(true);

    await store.delete({ orgId, actorId, objectId: objectIdB });
    expect(state.blobs.has(sha256)).toBe(false);
    expect(storage.deletes).toEqual([blobKey]);
    expect(storage.objects.has(blobKey)).toBe(false);
  });

  it("inline content path puts once to the blob key on first finalize", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        { sha256: string; storageKey: string; refcount: number; byteSize: number }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
    };
    const storage = new MemoryStorage();
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
    });

    const version = await store.finalizeUpload({
      orgId,
      actorId,
      objectId: objectIdA,
      byteSize: content.byteLength,
      sha256,
      content,
    });
    expect(version.storageKey).toBe(blobKey);
    expect(storage.puts).toHaveLength(1);
    const firstPut = storage.puts[0];
    if (firstPut === undefined) throw new Error("Expected one storage write");
    expect(firstPut.key).toBe(blobKey);
    expect(Buffer.from(firstPut.body).equals(Buffer.from(content))).toBe(true);
  });

  it("commits a scanner-failure quarantine before rejecting finalize", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        { sha256: string; storageKey: string; refcount: number; byteSize: number }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
    };
    const storage = new MemoryStorage();
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
      virusScanner: {
        async scan() {
          return {
            clean: false,
            disposition: "quarantine",
            securityScan: {
              state: "scan_failed",
              evidence: {
                scannerName: "clamav",
                scannerVersion: "unknown",
                startedAt: "2026-07-28T12:00:00.000Z",
                completedAt: "2026-07-28T12:00:01.000Z",
                byteSize: content.byteLength,
              },
            },
          };
        },
      },
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
        content,
      }),
    ).rejects.toThrow("quarantined");

    expect(state.versions).toHaveLength(0);
    expect(state.objects.get(objectIdA)?.metadata).toMatchObject({
      status: "quarantined",
      malwareScan: {
        state: "scan_failed",
        disposition: "quarantine",
      },
    });
    expect(storage.objects.has(blobKey)).toBe(true);
  });

  it("marks an allowed Personal scanner outage explicitly unscanned", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        { sha256: string; storageKey: string; refcount: number; byteSize: number }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
    };
    const storage = new MemoryStorage();
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
      virusScanner: {
        async scan() {
          return {
            clean: false,
            disposition: "allow_unscanned",
            securityScan: {
              state: "scan_failed",
              evidence: {
                scannerName: "clamav",
                scannerVersion: "unknown",
                startedAt: "2026-07-28T12:00:00.000Z",
                completedAt: "2026-07-28T12:00:01.000Z",
                byteSize: content.byteLength,
              },
            },
          };
        },
      },
    });

    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
        content,
      }),
    ).resolves.toMatchObject({ objectId: objectIdA });

    expect(state.versions).toHaveLength(1);
    expect(state.objects.get(objectIdA)?.metadata).toMatchObject({
      status: "ready",
      malwareScan: {
        state: "scan_failed",
        disposition: "allow_unscanned",
      },
    });
  });
});
