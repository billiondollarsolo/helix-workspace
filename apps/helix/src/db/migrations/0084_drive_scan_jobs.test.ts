import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0084 Drive scan jobs migration", () => {
  it("adds tenant-scoped leased retry, dead-letter, and override state", async () => {
    const sql = await readFile(new URL("./0084_drive_scan_jobs.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table if not exists drive_scan_jobs");
    expect(sql).toContain("'pending', 'processing', 'dead_lettered'");
    expect(sql).toContain("attempt_count integer not null");
    expect(sql).toContain("lease_expires_at timestamptz");
    expect(sql).toContain("last_override_reason text");
    expect(sql).toContain("create unique index if not exists drive_scan_jobs_org_object_idx");
    expect(sql).toContain("drive_scan_jobs_state_check");
    expect(sql).toContain("alter table drive_scan_jobs enable row level security");
    expect(sql).toContain("with check (org_id = helix_current_org_id())");
  });
});
