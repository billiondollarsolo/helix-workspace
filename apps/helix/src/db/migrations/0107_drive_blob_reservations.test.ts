import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("0107 Drive blob reservations", () => {
  const migration = readFileSync(
    new URL("./0107_drive_blob_reservations.sql", import.meta.url),
    "utf8",
  );

  it("protects in-flight content-addressed blobs and enforces tenant isolation", () => {
    expect(migration).toContain("drive_blob_reservations");
    expect(migration).toContain("unique index if not exists drive_blob_reservations_object_idx");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("helix_current_org_id()");
  });
});
