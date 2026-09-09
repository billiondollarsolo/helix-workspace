import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0097 Drive multipart sessions migration", () => {
  it("binds upload plans and installs leased tenant-scoped sweeping", async () => {
    const migration = await readFile(
      new URL("./0097_drive_multipart_sessions.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("create table if not exists drive_multipart_sessions");
    expect(migration).toContain("actor_id uuid references actors(id) on delete set null");
    expect(migration).toContain("completion_hash text");
    expect(migration).toContain("drive_multipart_sessions_org_upload_idx");
    expect(migration).toContain("drive_multipart_sessions_state_check");
    expect(migration).toContain("alter table drive_multipart_sessions force row level security");
    expect(migration).toContain("with check (org_id = helix_current_org_id())");
    expect(migration).not.toContain("object_id uuid not null references objects");
  });
});
