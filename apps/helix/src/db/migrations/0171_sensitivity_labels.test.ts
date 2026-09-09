import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0171_sensitivity_labels.sql", import.meta.url), "utf8");

describe("0171 sensitivity labels", () => {
  it("defines one required policy contract and canonical Drive identity", () => {
    for (const label of ["public", "standard", "confidential", "restricted"]) {
      expect(migration).toContain(`('${label}',`);
    }
    for (const field of [
      "display_name",
      "description",
      "color",
      "marking",
      "retention_days",
      "encryption",
      "external_sharing_allowed",
      "recording_export_allowed",
      "boundary_actions",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain("'drive.file'");
    expect(migration).toContain("delete from resource_classifications");
  });

  it("enforces downgrade, inheritance, projections, retention, and audit in the database", () => {
    expect(migration).toContain("allow_sensitivity_downgrade");
    expect(migration).toContain("requires security-administrator permission");
    expect(migration).toContain("objects_inherit_sensitivity");
    expect(migration).toContain("drive_folders_inherit_sensitivity");
    expect(migration).toContain("resource_classifications_propagate_folder");
    expect(migration).toContain("'{sensitivityLabel}'");
    expect(migration).toContain("meet_recording_governance");
    expect(migration).toContain("greatest(retention_until, new.retention_until)");
    expect(migration).toContain("'sensitivity.label.changed'");
    expect(migration).toContain("insert into activity");
  });
});
