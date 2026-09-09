import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0161 directory group principals migration", () => {
  it("uses one tenant-bound membership resolver for RBAC and product access", async () => {
    const migration = await readFile(
      new URL("./0161_directory_group_principals.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("helix_directory_group_contains");
    expect(migration).toContain("principal_type in ('membership', 'service_account', 'group')");
    expect(migration).toContain("directory_group_resource_grants");
    expect(migration).toContain("resource_type in ('object', 'thread', 'calendar')");
    expect(migration).toContain("after insert or update of org_id, group_id, actor_id or delete");
    expect(migration).toContain("helix_grant_directory_group_resource");
    expect(migration).toContain("helix_revoke_directory_group_resource");
    expect(migration).toContain("force row level security");
  });

  it("keeps generated access derived and rejects tenant/resource confusion", async () => {
    const migration = await readFile(
      new URL("./0161_directory_group_principals.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("source_group_grant_id");
    expect(migration).toContain("group grant context does not match actor");
    expect(migration).toContain("actor cannot share this resource");
    expect(migration).toContain("permissions_repair_group_grant");
    expect(migration).toContain("cal_memberships_repair_group_grant");
  });
});
