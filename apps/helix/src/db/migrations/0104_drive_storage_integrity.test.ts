import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0104_drive_storage_integrity.sql", import.meta.url),
  "utf8",
);

describe("0104 Drive storage integrity migration", () => {
  it("makes byte sizes bigint-safe and derives one blob reference per version", () => {
    expect(migration).toContain("objects alter column byte_size type bigint");
    expect(migration).toContain("drive_versions alter column byte_size type bigint");
    expect(migration).toContain("drive_multipart_sessions alter column byte_size type bigint");
    expect(migration).toContain("meet_recording_uploads alter column byte_size type bigint");
    expect(migration).toContain("check (refcount >= 0)");
    expect(migration).toContain("count(*)::integer");
    expect(migration).toContain("drive_blobs_org_storage_key_idx");
    expect(migration).toContain("losing_keys");
    expect(migration).toContain("insert into drive_quarantine_deletions");
    expect(migration).toContain("update drive_versions version");
  });

  it("adds version idempotency and storage-key reconciliation indexes", () => {
    expect(migration).toContain("idempotency_key text");
    expect(migration).toContain("drive_versions_idempotency_idx");
    expect(migration).toContain("drive_versions_org_storage_idx");
  });
});
