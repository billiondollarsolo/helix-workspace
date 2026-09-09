import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
const sql = databaseUrl === undefined ? null : postgres(databaseUrl, { max: 2, prepare: false });

describe.skipIf(sql === null)("durable Drive orphan grace", () => {
  const database = sql as postgres.Sql;
  const orgId = "d2300000-0000-4000-8000-000000000001";
  const key = `drive/${orgId}/blobs/${"a".repeat(64)}`;
  const removed: string[] = [];
  const storage = {
    async put() {},
    async get() {
      return null;
    },
    async delete(storageKey: string) {
      removed.push(storageKey);
    },
  };
  const gc = { enabled: true, intervalMs: 1_000, orphanGraceHours: 1, batchSize: 1 };
  const store = new PostgresDriveStore(database, storage, { gc });
  async function cleanup() {
    await database`delete from drive_quarantine_deletions where org_id = ${orgId}`;
    await database`delete from drive_blobs where org_id = ${orgId}`;
    await database`delete from drive_lifecycle_policies where org_id = ${orgId}`;
    await database`delete from storage_usage_counters where org_id = ${orgId}`;
    await database`delete from orgs where id = ${orgId}`;
  }
  beforeAll(async () => {
    await cleanup();
    await database`insert into orgs (id, slug, display_name) values (${orgId}, 'drive-gc-verify', 'Drive GC')`;
    await database`insert into drive_lifecycle_policies (org_id, trash_retention_days, orphan_grace_hours) values (${orgId}, 30, 24)`;
    await database`insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount, updated_at)
      values (${orgId}, ${"a".repeat(64)}, ${key}, 3, 0, now() - interval '2 hours')`;
  });
  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("honors tenant grace, retains orphan age, and gates collection without blocking other cleanup", async () => {
    const before = await database`select updated_at from drive_blobs where org_id = ${orgId}`;
    await store.runVirusScanRetryBatch({ limit: 100, leaseMs: 30_000, includeVirusScans: false });
    expect(removed).not.toContain(key);
    const after = await database`select updated_at from drive_blobs where org_id = ${orgId}`;
    expect(after[0]?.updated_at).toEqual(before[0]?.updated_at);
    await database`update drive_blobs set updated_at = now() - interval '25 hours' where org_id = ${orgId}`;
    const disabled = new PostgresDriveStore(database, storage, { gc: { ...gc, enabled: false } });
    await disabled.runVirusScanRetryBatch({
      limit: 100,
      leaseMs: 30_000,
      includeVirusScans: false,
    });
    expect(removed).not.toContain(key);
    await store.runVirusScanRetryBatch({ limit: 100, leaseMs: 30_000, includeVirusScans: false });
    expect(removed).not.toContain(key);
    await store.runVirusScanRetryBatch({
      limit: 100,
      leaseMs: 30_000,
      includeVirusScans: false,
      now: new Date(Date.now() + 2_000),
    });
    expect(removed).toContain(key);
  });
});
