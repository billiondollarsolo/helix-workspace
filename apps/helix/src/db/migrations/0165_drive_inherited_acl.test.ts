import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./0165_drive_inherited_acl.sql", import.meta.url), "utf8");
const store = readFileSync(
  new URL("../../platform/drive/store.ts", import.meta.url),
  "utf8",
);

describe("0165 inherited Drive ACL", () => {
  it("uses one evaluator for every principal and organization-owned shared Drives", () => {
    for (const principal of ["permissions", "directory_group_resource_grants", "drive_domain_grants"]) {
      expect(migration).toContain(principal);
    }
    expect(migration).toContain("drive_acl_exceptions");
    expect(migration).toContain("helix_directory_group_contains");
    expect(migration).toContain("helix_drive_effective_role");
    expect(migration).toContain("helix_drive_visible_actor_ids");
    expect(migration).toContain("helix_drive_create_shared_drive");
    expect(migration).toContain("helix_drive_move_object");
    expect(migration).toContain("helix_drive_move_folder");
    expect(migration).toContain("organization-owned shared Drive files cannot transfer ownership");
    expect(migration).toContain("force row level security");
    expect(store).toContain("helix_drive_effective_role(");
    expect(store).toContain("helix_drive_visible_actor_ids(");
  });
});
