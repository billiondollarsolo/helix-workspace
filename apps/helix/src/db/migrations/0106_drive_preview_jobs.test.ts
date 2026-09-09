import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0106_drive_preview_jobs.sql", import.meta.url), "utf8");

describe("0106 Drive preview jobs migration", () => {
  it("persists leased version-specific preview regeneration under forced tenant RLS", () => {
    expect(migration).toContain("version_id uuid not null references drive_versions(id)");
    expect(migration).toContain("unique (org_id, version_id)");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("helix_current_org_id()");
  });
});
