import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { PostgresDriveStore } from "./store.js";

async function readAggregates(...names: string[]): Promise<string> {
  return (
    await Promise.all(
      names.map((name) => readFile(new URL(`./store/${name}.ts`, import.meta.url), "utf8")),
    )
  ).join("\n");
}

describe("Drive production store invariants", () => {
  it("scopes recipients to the organization and never queries a raw share token", async () => {
    const source = await readAggregates("shares", "share-links", "share-policy");
    const integrity = await readFile(
      new URL("../../db/migrations/0094_chat_permission_validity.sql", import.meta.url),
      "utf8",
    );
    expect(integrity).toContain("foreign key (org_id, actor_id) references actors (org_id, id)");
    expect(source).toContain(
      "values (${input.orgId}, ${targetActorId}, 'object', ${input.objectId}",
    );
    expect(source).toContain("helix_drive_share_link_by_token_hash(${tokenHash})");
    expect(source).toContain("const tokenHash = sha256Hex(input.token)");
    expect(source).not.toContain("where token = ${");
  });

  it("atomically enforces link expiry, download count, rate, and revocation", async () => {
    const source = await readAggregates("share-links", "share-policy");
    const resolver = source.slice(
      source.indexOf("async function resolveShareLink"),
      source.indexOf("async function openFileByShareToken"),
    );
    expect(source).toContain("download_count = link.download_count + 1");
    expect(source).toContain("link.download_count < link.max_downloads");
    expect(source).toMatch(/link\.rate_limit_per_hour,\s*3600/u);
    expect(source).toContain("revoked_at is null");
    expect(resolver.indexOf("consumeDriveShareRateLimit")).toBeLessThan(
      resolver.indexOf("driveShareDenialReason"),
    );
  });

  it("blocks hard delete for holds, shares, jobs, and retention", async () => {
    const source = await readAggregates("lifecycle");
    expect(source).toContain("await assertDriveObjectPurgeAllowed(tx, object)");
    expect(source).toContain("from drive_scan_jobs");
    expect(source).toContain("from drive_share_links");
    expect(source).toContain("object.trash_purge_after > new Date()");
  });

  it("stops a blocked purge before database or storage deletion", async () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const actorId = "22222222-2222-4222-8222-222222222222";
    const objectId = "33333333-3333-4333-8333-333333333333";
    const queries: string[] = [];
    const tag = (async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      queries.push(query);
      if (query.includes("from objects"))
        return [
          {
            id: objectId,
            org_id: orgId,
            owner_actor_id: actorId,
            deleted_at: new Date(0),
            trash_purge_after: new Date(1),
          },
        ];
      if (query.includes("from drive_retention_holds")) return [{ blocked: true }];
      return [];
    }) as unknown as postgres.Sql;
    Object.assign(tag, { begin: async (fn: (tx: postgres.Sql) => unknown) => fn(tag) });
    const remove = vi.fn(async () => {});
    const store = new PostgresDriveStore(tag, {
      async put() {},
      async get() {
        return null;
      },
      delete: remove,
    });
    await expect(store.delete({ orgId, actorId, objectId })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(queries.some((query) => query.includes("delete from"))).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("claims bounded orphan batches with skip-locked semantics", async () => {
    const source = await readAggregates(
      "scan-jobs",
      "multipart",
      "upload-expiry",
      "quarantine",
      "blobs",
    );
    expect(source).toContain("for update skip locked");
    expect(source).toContain("abortMultipartUpload");
    expect(source).toContain("claimExpiredPreparedUploads(tx,");
    expect(source).toContain("claimExpiredDriveMultipartSessions(tx,");
    expect(source).toContain("blob.refcount = 0");
    const reconcile = await readAggregates("blobs");
    expect(reconcile).toContain("where drive_quarantine_deletions.status = 'completed'");
    expect(source).toContain("reservation.expires_at > now()");
    expect(source).toContain("storage.delete(orphan.storage_key)");
  });

  it("reserves pending declared bytes in tenant quota accounting", async () => {
    const source = await readAggregates("uploads", "quotas");
    const prepare = source.slice(
      source.indexOf("async function prepareUpload("),
      source.indexOf("async function finalizeUpload("),
    );
    expect(prepare).toContain("await reserveDriveStorageQuota(");
    expect(source).toContain("select * from helix_reserve_drive_storage(");
  });
});
