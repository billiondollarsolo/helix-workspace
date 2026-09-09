import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { DriveConflictError } from "./errors.js";
import { PostgresDriveStore, type DriveStorageClient } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-07-28T00:00:00.000Z");

const pendingObject = {
  entry_type: "file",
  name: "pending.bin",
  folder_id: null,
  app: null,
  sort_name: "pending.bin",
  sort_type: 1,
  snapshot_at: now,
  starred: false,
  id: objectId,
  org_id: orgId,
  owner_actor_id: actorId,
  kind: "file",
  storage_key: "drive/pending.bin",
  mime_type: "application/octet-stream",
  byte_size: 3,
  sha256: "a".repeat(64),
  upload_state: "scanning",
  metadata: { name: "pending.bin", status: "scan_pending" },
  deleted_at: null,
  created_at: now,
  updated_at: now,
  version_number: 1,
  mine: true,
  shared_count: 0,
  owner_display_name: "Ada",
  owner_email: "ada@example.test",
  folder_path: [],
} as const;

function pendingSql(): postgres.Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("helix_consume_drive_share_rate_limit"))
      return Promise.resolve([{ allowed: true }]);
    if (text.includes("helix_drive_share_link_by_token_hash")) return Promise.resolve([]);
    if (!/^(select|with|update|insert|delete|set)\b/iu.test(text.trimStart()))
      return { text, values };
    if (text.includes("visible_entries as")) return Promise.resolve([pendingObject]);
    if (text.includes("from objects") && !text.includes("= 'ready'"))
      return Promise.resolve([pendingObject]);
    return Promise.resolve([]);
  };
  const sql = tag as unknown as postgres.Sql;
  Object.assign(sql, {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
    json: (value: unknown) => value,
  });
  return sql;
}

describe("Drive non-active availability invariants", () => {
  it("surfaces owner-visible processing files in list only as unavailable, never in search/index", async () => {
    const store = new PostgresDriveStore(pendingSql());

    const listed = await store.list({ orgId, actorId });
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({
      id: objectId,
      uploadState: "scanning",
      available: false,
      uploadStatusLabel: "Scanning for malware",
    });
    // Search and indexing projections still omit non-active objects.
    await expect(store.search({ orgId, actorId })).resolves.toEqual([]);
    await expect(store.getDriveSearchRecord(objectId)).resolves.toBeNull();
  });

  it("denies download, preview/agent reads, direct sharing, and public-link reads", async () => {
    const get = vi.fn<DriveStorageClient["get"]>();
    const storage: DriveStorageClient = {
      async put() {},
      get,
      async delete() {},
    };
    const store = new PostgresDriveStore(pendingSql(), storage);

    await expect(store.readFile({ orgId, actorId, objectId })).resolves.toBeNull();
    await expect(
      store.share({
        orgId,
        actorId,
        objectId,
        targetActorIds: ["44444444-4444-4444-8444-444444444444"],
        role: "reader",
      }),
    ).rejects.toBeInstanceOf(DriveConflictError);
    await expect(
      store.openFileByShareToken({ token: "s".repeat(43), clientKey: "a".repeat(64) }),
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
