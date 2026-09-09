/**
 * Store-level content-addressed dedup tests.
 * Drives the real PostgresDriveStore.finalizeUpload / delete paths with a
 * recording SQL + in-memory storage client — no live Postgres required.
 */
import type postgres from "postgres";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { driveBlobKey, driveQuarantineStorageKey } from "./core/storage-key.js";
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
interface ScanJobState {
  id: string;
  org_id: string;
  object_id: string;
  actor_id: string;
  status: "pending" | "processing" | "dead_lettered";
  attempt_count: number;
  next_attempt_at: Date | null;
  finalize_metadata: Record<string, unknown>;
}
interface QuarantineDeletionState {
  id: string;
  org_id: string;
  object_id: string;
  actor_id: string | null;
  storage_key: string;
  status: "pending" | "processing";
  attempt_count: number;
  next_attempt_at: Date;
}
interface DedupObjectRow {
  id: string;
  org_id: string;
  owner_actor_id: string;
  kind: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string | null;
  metadata: {
    name: string;
    folderId: null;
    status: string;
  };
  deleted_at: Date | null;
  trash_purge_after: Date | null;
  retain_until: Date | null;
  created_at: Date;
  updated_at: Date;
}
function objectRow(
  objectId: string,
  storageKey: string,
  sha: string | null = null,
): DedupObjectRow {
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
    trash_purge_after: null,
    retain_until: null,
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
  readonly puts: Array<{
    key: string;
    body: Uint8Array;
  }> = [];
  readonly deletes: string[] = [];
  readonly objects = new Map<string, Uint8Array>();
  readonly deleteFailures = new Map<string, number>();
  constructor(private readonly onExternalCall?: () => void) {}
  async put(object: { key: string; body: Uint8Array | AsyncIterable<Uint8Array> }): Promise<void> {
    this.onExternalCall?.();
    const body =
      object.body instanceof Uint8Array
        ? object.body
        : new Uint8Array(await collectAsync(object.body));
    this.puts.push({ key: object.key, body });
    this.objects.set(object.key, body);
  }
  async get(key: string): Promise<{
    key: string;
    body: Uint8Array;
  } | null> {
    this.onExternalCall?.();
    const body = this.objects.get(key);
    return body === undefined ? null : { key, body };
  }
  async delete(key: string): Promise<void> {
    this.onExternalCall?.();
    this.deletes.push(key);
    const failures = this.deleteFailures.get(key) ?? 0;
    if (failures > 0) {
      this.deleteFailures.set(key, failures - 1);
      throw new Error("object store delete failed");
    }
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
  objects: Map<string, DedupObjectRow>;
  blobs: Map<
    string,
    {
      sha256: string;
      storageKey: string;
      refcount: number;
      byteSize: number;
    }
  >;
  versions: Array<ReturnType<typeof versionRow>>;
  scanJobs?: Map<string, ScanJobState>;
  quarantineDeletions?: Map<string, QuarantineDeletionState>;
  storageDeltas?: number[];
  onTransactionChange?: (active: boolean) => void;
}) {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id")) {
      return { text, values };
    }
    if (text.includes("select id from orgs")) {
      return Promise.resolve(values.includes(orgId) ? [] : [{ id: orgId }]);
    }
    if (text.includes("helix_reconcile_storage_usage")) return Promise.resolve([]);
    if (
      text.includes("helix_reserve_drive_storage") ||
      text.includes("helix_commit_storage_usage")
    ) {
      if (text.includes("helix_commit_storage_usage")) {
        state.storageDeltas?.push(Number(values[2]));
      }
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
    if (text.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    if (text.includes("delete from drive_blob_reservations")) return Promise.resolve([]);
    if (text.includes("insert into drive_blob_reservations")) {
      return Promise.resolve([{ id: "reservation-1" }]);
    }
    if (text.includes("insert into drive_blobs") && text.includes("select org_id")) {
      return Promise.resolve([]);
    }
    if (
      text.includes("insert into drive_quarantine_deletions") &&
      text.includes("from drive_blobs")
    ) {
      return Promise.resolve([]);
    }
    if (text.includes("update drive_blobs blob") && text.includes("set refcount = 0")) {
      return Promise.resolve([]);
    }
    if (text.includes("with candidates as") && text.includes("drive_quarantine_deletions")) {
      return Promise.resolve(
        [...(state.quarantineDeletions?.values() ?? [])]
          .filter((job) => job.status === "pending")
          .map((job) => {
            job.status = "processing";
            return { ...job };
          }),
      );
    }
    if (text.includes("with candidates as") && text.includes("upload_expiring")) {
      return Promise.resolve([]);
    }
    if (text.includes("insert into drive_quarantine_deletions")) {
      const objectId = values.find((value) => value === objectIdA || value === objectIdB) as string;
      const storageKey = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("drive"),
      );
      if (storageKey === undefined) throw new Error("Expected quarantine deletion storage key");
      const existing = state.quarantineDeletions?.get(storageKey);
      const job: QuarantineDeletionState = {
        id: existing?.id ?? `delete-${String(state.quarantineDeletions?.size ?? 0)}`,
        org_id: orgId,
        object_id: objectId,
        actor_id: actorId,
        storage_key: storageKey,
        status: "pending",
        attempt_count: existing?.attempt_count ?? 0,
        next_attempt_at: new Date(),
      };
      state.quarantineDeletions?.set(storageKey, job);
      return Promise.resolve([job]);
    }
    if (text.includes("delete from drive_quarantine_deletions")) {
      const id = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("delete-"),
      );
      const job = [...(state.quarantineDeletions?.values() ?? [])].find(
        (candidate) => candidate.id === id,
      );
      if (job === undefined) return Promise.resolve([]);
      state.quarantineDeletions?.delete(job.storage_key);
      return Promise.resolve([job]);
    }
    if (text.includes("drive_comment_actor_role_rank")) {
      const objectId = values.find(
        (value) => typeof value === "string" && state.objects.has(value),
      );
      const row = typeof objectId === "string" ? state.objects.get(objectId) : undefined;
      return Promise.resolve(row === undefined ? [] : [{ ...row, comment_role_rank: 3 }]);
    }
    if (
      text.includes("update drive_quarantine_deletions") &&
      text.includes("status = 'completed'")
    ) {
      const id = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("delete-"),
      );
      const job = [...(state.quarantineDeletions?.values() ?? [])].find(
        (candidate) => candidate.id === id,
      );
      if (job === undefined) return Promise.resolve([]);
      state.quarantineDeletions?.delete(job.storage_key);
      return Promise.resolve([{ ...job, status: "completed", completed_at: new Date() }]);
    }
    if (text.includes("update drive_quarantine_deletions")) {
      const id = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("delete-"),
      );
      const job = [...(state.quarantineDeletions?.values() ?? [])].find(
        (candidate) => candidate.id === id,
      );
      if (job === undefined) return Promise.resolve([]);
      job.status = "pending";
      job.attempt_count += 1;
      job.next_attempt_at =
        values.find((value): value is Date => value instanceof Date) ?? new Date();
      return Promise.resolve([{ ...job }]);
    }
    // requireObjectAccess
    if (text.includes("select *") && text.includes("from objects") && text.includes("kind in")) {
      const objectId = values.find((v) => typeof v === "string" && state.objects.has(v)) as
        string | undefined;
      if (objectId === undefined) return Promise.resolve([]);
      const row = state.objects.get(objectId);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    // quota select — unlimited
    if (text.includes("storage_bytes_limit") || text.includes("storage_used")) {
      return Promise.resolve([{ storage_bytes_limit: null, storage_used_bytes: 0 }]);
    }
    if (text.includes("select storage_key, refcount") && text.includes("from drive_blobs")) {
      const sha = values.find((value) => typeof value === "string" && value.length === 64);
      const blob = [...state.blobs.values()].find((candidate) => candidate.sha256 === sha);
      return Promise.resolve(
        blob === undefined ? [] : [{ storage_key: blob.storageKey, refcount: blob.refcount }],
      );
    }
    if (text.trimStart().startsWith("select 1") && text.includes("from drive_blobs")) {
      const sha = values.find((value) => typeof value === "string" && value.length === 64);
      const key = values.find((value) => typeof value === "string" && value.includes("/blobs/"));
      return Promise.resolve(
        [...state.blobs.values()].some(
          (blob) => (blob.sha256 === sha || blob.storageKey === key) && blob.refcount > 0,
        )
          ? [{ exists: 1 }]
          : [],
      );
    }
    if (
      text.includes("with candidates as") &&
      text.includes("drive_scan_jobs") &&
      text.includes("update drive_scan_jobs")
    ) {
      return Promise.resolve(
        [...(state.scanJobs?.values() ?? [])]
          .filter((job) => job.status === "pending")
          .map((job) => {
            job.status = "processing";
            const object = state.objects.get(job.object_id);
            return {
              ...job,
              owner_actor_id: object?.owner_actor_id ?? null,
              storage_key: object?.storage_key ?? "",
              mime_type: object?.mime_type ?? "application/octet-stream",
              byte_size: object?.byte_size ?? 0,
              sha256: object?.sha256 ?? null,
            };
          }),
      );
    }
    if (text.includes("insert into drive_scan_jobs")) {
      const objectId = values.find((value) => value === objectIdA || value === objectIdB) as string;
      const existing = state.scanJobs?.get(objectId);
      const maxAttempts = values.find((value) => typeof value === "number" && value > 1) as number;
      const advancesAttempt = existing === undefined || existing.status === "processing";
      const attempts = (existing?.attempt_count ?? 0) + (advancesAttempt ? 1 : 0);
      const status = advancesAttempt
        ? attempts >= maxAttempts
          ? "dead_lettered"
          : "pending"
        : existing.status;
      const dates = values.filter((value): value is Date => value instanceof Date);
      const metadata =
        values.find(
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null && !(value instanceof Date),
        ) ?? {};
      const job: ScanJobState = {
        id: existing?.id ?? `scan-${objectId}`,
        org_id: orgId,
        object_id: objectId,
        actor_id: actorId,
        status,
        attempt_count: attempts,
        next_attempt_at: status === "dead_lettered" ? null : (dates[0] ?? null),
        finalize_metadata: metadata,
      };
      state.scanJobs?.set(objectId, job);
      return Promise.resolve([job]);
    }
    if (text.includes("update drive_scan_jobs") && text.includes("override_count")) {
      const objectId = values.find((value) => value === objectIdA || value === objectIdB) as string;
      const job = state.scanJobs?.get(objectId);
      if (job?.status !== "dead_lettered") return Promise.resolve([]);
      job.status = "pending";
      job.attempt_count = 0;
      job.next_attempt_at = new Date();
      return Promise.resolve([{ id: job.id }]);
    }
    if (text.includes("delete from drive_scan_jobs")) {
      const objectId = values.find((value) => value === objectIdA || value === objectIdB) as string;
      state.scanJobs?.delete(objectId);
      return Promise.resolve([]);
    }
    // drive_blobs upsert
    if (text.includes("insert into drive_blobs")) {
      const sha = values.find((v) => typeof v === "string" && v.length === 64) as string;
      const key = values.find(
        (value): value is string => typeof value === "string" && value.includes("/blobs/"),
      );
      if (key === undefined) throw new Error("Expected a blob storage key");
      const existing = state.blobs.get(sha);
      const isReservation = text.includes("0, 0");
      if (existing === undefined) {
        state.blobs.set(sha, {
          sha256: sha,
          storageKey: key,
          refcount: isReservation ? 0 : 1,
          byteSize: content.byteLength,
        });
        return Promise.resolve(isReservation ? [] : [{ newly_referenced: true }]);
      }
      if (isReservation) return Promise.resolve([]);
      const newlyReferenced = existing.refcount === 0;
      existing.refcount += 1;
      return Promise.resolve([{ newly_referenced: newlyReferenced }]);
    }
    // drive_blobs decrement
    if (text.includes("update drive_blobs") && text.includes("refcount = refcount -")) {
      const key = values.find(
        (value): value is string => typeof value === "string" && value.includes("/blobs/"),
      );
      if (key === undefined) return Promise.resolve([]);
      for (const blob of state.blobs.values()) {
        if (blob.storageKey === key) {
          const amount = values.find((value): value is number => typeof value === "number") ?? 1;
          blob.refcount -= amount;
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
    // objects update after finalize/quarantine
    if (text.includes("update objects") && text.includes("storage_key")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string | undefined;
      const storageKey = values.find(
        (value): value is string =>
          typeof value === "string" &&
          (value.startsWith("drive/") || value.startsWith("drive-quarantine/")),
      );
      const metadata = values.find(
        (value): value is ReturnType<typeof objectRow>["metadata"] =>
          typeof value === "object" && value !== null && "status" in value,
      );
      if (objectId !== undefined && storageKey !== undefined) {
        const prev = state.objects.get(objectId);
        if (prev !== undefined) {
          state.objects.set(objectId, {
            ...prev,
            storage_key: storageKey,
            sha256,
            byte_size: content.byteLength,
            metadata: metadata ?? { ...prev.metadata, status: "ready" },
          });
        }
      }
      return Promise.resolve(objectId === undefined ? [] : [{ id: objectId }]);
    }
    // quarantine verdict update
    if (text.includes("update objects") && text.includes("metadata =")) {
      const objectId = values.find(
        (v) => typeof v === "string" && (v === objectIdA || v === objectIdB),
      ) as string | undefined;
      const metadata = values.find(
        (value): value is ReturnType<typeof objectRow>["metadata"] =>
          typeof value === "object" && value !== null && "status" in value,
      );
      const previous = objectId === undefined ? undefined : state.objects.get(objectId);
      if (objectId !== undefined && previous !== undefined && metadata !== undefined) {
        const digest = values.find(
          (value): value is string => typeof value === "string" && value.length === 64,
        );
        state.objects.set(objectId, {
          ...previous,
          ...(digest === undefined ? {} : { sha256: digest }),
          metadata,
        });
      } else if (
        objectId !== undefined &&
        previous !== undefined &&
        text.includes("'scan_pending'")
      ) {
        state.objects.set(objectId, {
          ...previous,
          metadata: { ...previous.metadata, status: "scan_pending" },
        });
      }
      return Promise.resolve(
        objectId === undefined ? [] : [state.objects.get(objectId) ?? { id: objectId }],
      );
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
      return Promise.resolve([
        {
          version_number: text.includes("+ 1 as version_number")
            ? state.versions.length + 1
            : state.versions.length,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
      state.onTransactionChange?.(true);
      try {
        return await callback(sql as unknown as postgres.TransactionSql);
      } finally {
        state.onTransactionChange?.(false);
      }
    },
  }) as unknown as postgres.Sql;
  return sql;
}
describe("PostgresDriveStore content-addressed dedup", () => {
  it("cannot carry or inject preview metadata across a new file version", async () => {
    const target = {
      ...objectRow(objectIdA, reservedKeyA),
      metadata: {
        name: "a.bin",
        folderId: null,
        status: "ready",
        preview: {
          kind: "pdf",
          status: "available",
          storageKey: "drive-previews/stale.pdf",
        },
      },
    };
    const state = {
      objects: new Map([[objectIdA, target]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [versionRow(objectIdA, reservedKeyA, 1)],
    };
    const store = new PostgresDriveStore(createDedupSql(state), new MemoryStorage());
    await store.finalizeUpload({
      orgId,
      actorId,
      objectId: objectIdA,
      byteSize: content.byteLength,
      content,
      metadata: {
        preview: {
          kind: "pdf",
          status: "available",
          storageKey: "attacker-controlled-preview.pdf",
        },
      },
    });
    expect(state.objects.get(objectIdA)?.metadata).not.toHaveProperty("preview");
  });
  it("verifies staged bytes before a known digest can acquire a blob reference", async () => {
    const attackerBytes = new Uint8Array([1, 2, 3, 4]);
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map([
        [sha256, { sha256, storageKey: blobKey, refcount: 1, byteSize: content.byteLength }],
      ]),
      versions: [] as Array<ReturnType<typeof versionRow>>,
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, attackerBytes);
    storage.objects.set(blobKey, content);
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
    });
    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: attackerBytes.byteLength,
        sha256,
      }),
    ).rejects.toThrow("stored bytes");
    expect(state.blobs.get(sha256)?.refcount).toBe(1);
    expect(state.versions).toEqual([]);
    expect(storage.puts).toEqual([]);
  });
  it("commits an infected verdict, deletes staged bytes, and denies read/share", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, content);
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
      virusScanner: {
        async scan() {
          return { clean: false, signature: "Eicar-Test-Signature" };
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
      }),
    ).rejects.toThrow("virus scan");
    expect(state.objects.get(objectIdA)?.metadata).toMatchObject({
      status: "infected",
      avSignature: "Eicar-Test-Signature",
    });
    expect(storage.objects.has(reservedKeyA)).toBe(false);
    expect(state.versions).toEqual([]);
    await expect(store.readFile({ orgId, actorId, objectId: objectIdA })).resolves.toBeNull();
    await expect(
      store.share({
        orgId,
        actorId,
        objectId: objectIdA,
        targetActorIds: ["55555555-5555-4555-8555-555555555555"],
        role: "reader",
      }),
    ).rejects.toThrow("not ready");
  });
  it("keeps EICAR unreadable while failed byte deletions durably retry to completion", async () => {
    const quarantineKey = driveQuarantineStorageKey(orgId, objectIdA, sha256);
    const target = {
      ...objectRow(objectIdA, reservedKeyA),
      metadata: {
        name: "a.bin",
        folderId: null,
        status: "ready",
        textContent: "must disappear",
        tags: ["sensitive"],
      },
    };
    const state = {
      objects: new Map([[objectIdA, target]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      quarantineDeletions: new Map<string, QuarantineDeletionState>(),
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, content);
    storage.deleteFailures.set(quarantineKey, 1);
    storage.deleteFailures.set(reservedKeyA, 1);
    const deletionErrors: Array<{
      storageKey: string;
      attempts: number;
    }> = [];
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      virusScanner: {
        kind: "clamav",
        async scan() {
          return { clean: false, signature: "Eicar-Test-Signature" };
        },
      },
      virusScanRetryDelayMs: 1,
      onQuarantineDeleteError: ({ storageKey, attempts }) =>
        deletionErrors.push({ storageKey, attempts }),
    });
    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
      }),
    ).rejects.toMatchObject({
      details: { scanOutcome: "quarantined", signature: "Eicar-Test-Signature" },
    });
    expect(state.objects.get(objectIdA)).toMatchObject({
      storage_key: quarantineKey,
      metadata: { status: "infected" },
    });
    expect(state.objects.get(objectIdA)?.metadata).not.toHaveProperty("preview");
    expect(state.objects.get(objectIdA)?.metadata).not.toHaveProperty("textContent");
    expect(state.objects.get(objectIdA)?.metadata).not.toHaveProperty("tags");
    expect([...state.quarantineDeletions.values()]).toHaveLength(2);
    expect([...state.quarantineDeletions.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storage_key: quarantineKey, attempt_count: 1 }),
        expect.objectContaining({ storage_key: reservedKeyA, attempt_count: 1 }),
      ]),
    );
    expect(storage.objects.has(quarantineKey)).toBe(true);
    expect(storage.objects.has(reservedKeyA)).toBe(true);
    expect(deletionErrors).toEqual(
      expect.arrayContaining([
        { storageKey: quarantineKey, attempts: 1 },
        { storageKey: reservedKeyA, attempts: 1 },
      ]),
    );
    await expect(store.readFile({ orgId, actorId, objectId: objectIdA })).resolves.toBeNull();
    await expect(store.listVersions({ orgId, actorId, objectId: objectIdA })).rejects.toThrow(
      "not ready",
    );
    await expect(store.listAccess({ orgId, actorId, objectId: objectIdA })).rejects.toThrow(
      "not ready",
    );
    await expect(
      store.createComment({ orgId, actorId, objectId: objectIdA, body: "leak?" }),
    ).rejects.toThrow("not ready");
    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
      }),
    ).rejects.toThrow("quarantined");
    await expect(store.runVirusScanRetryBatch({ limit: 10, leaseMs: 30000 })).resolves.toEqual({
      claimed: 2,
      completed: 2,
      failed: 0,
    });
    expect(state.quarantineDeletions.size).toBe(0);
    expect(storage.objects.has(quarantineKey)).toBe(false);
    expect(storage.objects.has(reservedKeyA)).toBe(false);
  });
  it("routes a DLP quarantine decision through the inaccessible Drive quarantine", async () => {
    const quarantineKey = driveQuarantineStorageKey(orgId, objectIdA, sha256);
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      quarantineDeletions: new Map<string, QuarantineDeletionState>(),
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, content);
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      virusScanner: {
        async scan() {
          return { clean: true };
        },
      },
      dlp: {
        evaluate: async () => ({
          action: "quarantine",
          boundary: "drive_upload",
          classification: "restricted",
          findings: [{ detector: "credentials", classification: "restricted" }],
          acknowledged: false,
        }),
      },
    });
    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
      }),
    ).rejects.toMatchObject({
      message: "File was quarantined by DLP policy.",
      details: {
        scanOutcome: "quarantined",
        signature: "DLP.restricted",
        policy: "dlp",
      },
    });
    expect(state.objects.get(objectIdA)).toMatchObject({
      storage_key: quarantineKey,
      metadata: {
        status: "infected",
        dlpVerdict: "quarantined",
        dlpClassification: "restricted",
      },
    });
    await expect(store.readFile({ orgId, actorId, objectId: objectIdA })).resolves.toBeNull();
  });
  it("persists scanner outages through retry, DLQ, and an audited retry override", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      scanJobs: new Map<string, ScanJobState>(),
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, content);
    const unavailable: Array<{
      status: string;
      attempts: number;
    }> = [];
    const scan = vi.fn(async () => {
      throw new Error("clamd unavailable\ninternal detail");
    });
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      virusScanner: { kind: "clamav", scan },
      virusScanMaxAttempts: 2,
      virusScanRetryDelayMs: 10,
      onVirusScanUnavailable: ({ status, attempts }) => unavailable.push({ status, attempts }),
    });
    const finalize = () =>
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
        metadata: { source: "test" },
      });
    await expect(finalize()).rejects.toThrow("temporarily unavailable");
    expect(state.scanJobs.get(objectIdA)).toMatchObject({ status: "pending", attempt_count: 1 });
    expect(state.objects.get(objectIdA)?.metadata).toMatchObject({ status: "scan_pending" });
    await expect(finalize()).rejects.toThrow("queued for retry");
    expect(scan).toHaveBeenCalledOnce();
    await expect(store.runVirusScanRetryBatch({ limit: 1, leaseMs: 60000 })).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
    });
    expect(state.scanJobs.get(objectIdA)).toMatchObject({
      status: "dead_lettered",
      attempt_count: 2,
    });
    expect(state.objects.get(objectIdA)?.metadata).toMatchObject({ status: "scan_dead_letter" });
    await expect(finalize()).rejects.toThrow("administrator must authorize");
    expect(scan).toHaveBeenCalledTimes(2);
    await expect(
      store.retryDeadLetteredVirusScan({
        orgId,
        actorId,
        objectId: objectIdA,
        reason: "recovered",
      }),
    ).rejects.toThrow("specific antivirus retry reason");
    await expect(
      store.retryDeadLetteredVirusScan({
        orgId,
        actorId,
        objectId: objectIdA,
        reason: "scanner signatures were refreshed",
      }),
    ).resolves.toBe(true);
    expect(state.scanJobs.get(objectIdA)).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(unavailable).toEqual([
      { status: "pending", attempts: 1 },
      { status: "dead_lettered", attempts: 2 },
    ]);
    expect(state.versions).toEqual([]);
  });
  it("does not promote pending scans when only quarantine cleanup is enabled", async () => {
    const scanJob: ScanJobState = {
      id: "scan-disabled",
      org_id: orgId,
      object_id: objectIdA,
      actor_id: actorId,
      status: "pending",
      attempt_count: 1,
      next_attempt_at: new Date(0),
      finalize_metadata: {},
    };
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      scanJobs: new Map([[objectIdA, scanJob]]),
    };
    const store = new PostgresDriveStore(createDedupSql(state), new MemoryStorage());
    await expect(
      store.runVirusScanRetryBatch({
        limit: 10,
        leaseMs: 30000,
        includeVirusScans: false,
      }),
    ).resolves.toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(state.scanJobs.get(objectIdA)).toMatchObject({ status: "pending", attempt_count: 1 });
    expect(state.versions).toEqual([]);
  });
  it("promotes a blocked upload when the durable retry sees a clean scanner", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      scanJobs: new Map<string, ScanJobState>(),
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, content);
    let available = false;
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      virusScanner: {
        kind: "clamav",
        async scan() {
          if (!available) throw new Error("clamd unavailable");
          return { clean: true };
        },
      },
      virusScanMaxAttempts: 3,
      virusScanRetryDelayMs: 1,
    });
    await expect(
      store.finalizeUpload({
        orgId,
        actorId,
        objectId: objectIdA,
        byteSize: content.byteLength,
        sha256,
      }),
    ).rejects.toThrow("temporarily unavailable");
    available = true;
    await expect(store.runVirusScanRetryBatch({ limit: 10, leaseMs: 30000 })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    expect(state.scanJobs.has(objectIdA)).toBe(false);
    expect(state.versions).toHaveLength(1);
  });
  it("counts a quarantined retry as completed rather than a worker failure", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      scanJobs: new Map<string, ScanJobState>(),
    };
    const storage = new MemoryStorage();
    storage.objects.set(reservedKeyA, content);
    let infected = false;
    const store = new PostgresDriveStore(createDedupSql(state), storage, {
      virusScanner: {
        kind: "clamav",
        async scan() {
          if (!infected) throw new Error("clamd unavailable");
          return { clean: false, signature: "Eicar-Test-Signature" };
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
      }),
    ).rejects.toThrow("temporarily unavailable");
    infected = true;
    await expect(store.runVirusScanRetryBatch({ limit: 1, leaseMs: 60000 })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    expect(state.objects.get(objectIdA)?.metadata).toMatchObject({ status: "infected" });
    expect(state.scanJobs.has(objectIdA)).toBe(false);
  });
  it("uploads identical bytes twice with one storage write and refcount=2", async () => {
    const state = {
      objects: new Map([
        [objectIdA, objectRow(objectIdA, reservedKeyA)],
        [objectIdB, objectRow(objectIdB, reservedKeyB)],
      ]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
      >(),
      versions: [] as Array<ReturnType<typeof versionRow>>,
      storageDeltas: [] as number[],
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
    });
    expect(v2.storageKey).toBe(blobKey);
    expect(storage.puts.length).toBe(putsBefore);
    expect(state.blobs.get(sha256)?.refcount).toBe(2);
    expect(state.storageDeltas).toEqual([content.byteLength, 0]);
  });
  it("delete decrements refcount and only removes storage at zero", async () => {
    const state = {
      objects: new Map([
        [
          objectIdA,
          {
            ...objectRow(objectIdA, blobKey, sha256),
            metadata: { name: "a.bin", folderId: null, status: "ready" },
            deleted_at: new Date("2000-01-01T00:00:00.000Z"),
            trash_purge_after: new Date("2000-02-01T00:00:00.000Z"),
          },
        ],
        [
          objectIdB,
          {
            ...objectRow(objectIdB, blobKey, sha256),
            metadata: { name: "b.bin", folderId: null, status: "ready" },
            deleted_at: new Date("2000-01-01T00:00:00.000Z"),
            trash_purge_after: new Date("2000-02-01T00:00:00.000Z"),
          },
        ],
      ]),
      blobs: new Map([
        [sha256, { sha256, storageKey: blobKey, refcount: 2, byteSize: content.byteLength }],
      ]),
      versions: [versionRow(objectIdA, blobKey, 1), versionRow(objectIdB, blobKey, 1)],
      storageDeltas: [] as number[],
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
    expect(state.storageDeltas).toEqual([0]);
    await store.delete({ orgId, actorId, objectId: objectIdB });
    expect(state.blobs.has(sha256)).toBe(false);
    expect(storage.deletes).toEqual([blobKey]);
    expect(storage.objects.has(blobKey)).toBe(false);
    expect(state.storageDeltas).toEqual([0, -content.byteLength]);
  });
  it("removes one blob reference for every immutable version of the deleted object", async () => {
    const target = {
      ...objectRow(objectIdA, blobKey, sha256),
      metadata: { name: "a.bin", folderId: null, status: "ready" },
      deleted_at: new Date("2000-01-01T00:00:00.000Z"),
      trash_purge_after: new Date("2000-02-01T00:00:00.000Z"),
    };
    const state = {
      objects: new Map([[objectIdA, target]]),
      blobs: new Map([
        [sha256, { sha256, storageKey: blobKey, refcount: 2, byteSize: content.byteLength }],
      ]),
      versions: [versionRow(objectIdA, blobKey, 1), versionRow(objectIdA, blobKey, 2)],
    };
    const storage = new MemoryStorage();
    storage.objects.set(blobKey, content);
    await new PostgresDriveStore(createDedupSql(state), storage, {
      contentAddressedDedup: true,
    }).delete({ orgId, actorId, objectId: objectIdA });
    expect(state.versions).toEqual([]);
    expect(state.blobs.has(sha256)).toBe(false);
    expect(storage.deletes).toEqual([blobKey]);
  });
  it("inline content path puts once to the blob key on first finalize", async () => {
    const state = {
      objects: new Map([[objectIdA, objectRow(objectIdA, reservedKeyA)]]),
      blobs: new Map<
        string,
        {
          sha256: string;
          storageKey: string;
          refcount: number;
          byteSize: number;
        }
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
});
