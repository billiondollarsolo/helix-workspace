import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0093 Drive quarantine deletion migration", () => {
  it("keeps rejected-byte cleanup durable, leased, and tenant scoped", async () => {
    const sql = await readFile(
      new URL("./0093_drive_quarantine_deletions.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("create table if not exists drive_quarantine_deletions");
    expect(sql).toContain("drive_quarantine_deletions_org_key_idx");
    expect(sql).toContain("drive_quarantine_deletions_state_check");
    expect(sql).toContain("alter table drive_quarantine_deletions enable row level security");
    expect(sql).toContain("alter table drive_quarantine_deletions force row level security");
    expect(sql).toContain("with check (org_id = helix_current_org_id())");
    expect(sql).not.toContain("object_id uuid not null references objects");
  });
});
