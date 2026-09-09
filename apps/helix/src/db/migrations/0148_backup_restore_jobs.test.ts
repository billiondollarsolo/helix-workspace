import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("backup restore jobs migration", () => {
  it("makes restore requests durable, leased, idempotent, cancellable, and dual-controlled", async () => {
    const sql = await readFile(new URL("./0148_backup_restore_jobs.sql", import.meta.url), "utf8");

    expect(sql).toContain("unique (org_id, requested_by_actor_id, idempotency_key)");
    expect(sql).toContain("target_database text not null unique");
    expect(sql).toContain("target_object_bucket text not null unique");
    expect(sql).toContain("requester cannot approve their own job");
    expect(sql).toContain(">= 2");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("lease_token = gen_random_uuid()");
    expect(sql).toContain("helix_backup_restore_cancel_requested");
    expect(sql).toContain("helix_mark_backup_restore_job_cancelled");
    expect(sql.match(/force row level security/gu)).toHaveLength(2);
    expect(sql).toContain("revoke execute on function helix_approve_backup_restore_job");
  });
});
