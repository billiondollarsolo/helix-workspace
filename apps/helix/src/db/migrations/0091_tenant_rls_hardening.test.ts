import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("tenant PostgreSQL hardening migrations", () => {
  it("separates migration ownership from constrained runtime roles", async () => {
    const sql = await readFile(
      new URL("./0090_postgres_runtime_roles.sql", import.meta.url),
      "utf8",
    );

    for (const role of ["helix_app", "helix_worker", "helix_readonly"]) {
      expect(sql).toContain(`alter role ${role} login nosuperuser nobypassrls noinherit`);
    }
    expect(sql).toContain("alter table %I.%I owner to helix_migration_owner");
    expect(sql).toContain("'alter %s %I.%I(%s) owner to helix_migration_owner'");
    expect(sql).toContain("alter default privileges for role helix_migration_owner");
    expect(sql).toContain("grant select on all tables in schema public to helix_readonly");
    expect(sql).toContain("revoke execute on all functions in schema public from public");
  });

  it("forces the canonical tenant policy on every discovered org_id table", async () => {
    const sql = await readFile(new URL("./0091_force_tenant_rls.sql", import.meta.url), "utf8");

    expect(sql).toContain("a.attname = 'org_id'");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("create policy helix_tenant_isolation");
    expect(sql).toContain("with check (org_id = helix_current_org_id())");
    expect(sql).toContain("create or replace function helix_current_actor_id()");
    expect(sql).toContain("security definer");
    expect(sql).toContain("where domain.domain = hostname");
  });
});
