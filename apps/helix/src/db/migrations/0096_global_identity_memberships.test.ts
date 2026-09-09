import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0096 global identity memberships", () => {
  it("separates global subjects, provider links, and tenant authority", async () => {
    const migration = await readFile(
      new URL("./0096_global_identity_memberships.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("create table if not exists identity_subjects");
    expect(migration).toContain("create table if not exists identity_provider_subjects");
    expect(migration).toContain("create table if not exists organization_memberships");
    expect(migration).toContain("unique (subject_id, org_id)");
    expect(migration).toContain("foreign key (org_id, actor_id)");
    expect(migration).toContain("force row level security");
    expect(migration).toContain('alter table "user" drop column if exists actor_id');
  });

  it("serializes activation and makes membership state part of credential validity", async () => {
    const migration = await readFile(
      new URL("./0096_global_identity_memberships.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("helix_activate_identity_membership");
    expect(migration.match(/pg_advisory_xact_lock/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain("target_provider || ':' || target_provider_subject");
    expect(migration).toContain("'email:' || normalized_email");
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain("subject.status = 'active'");
    expect(migration).toContain("actor.type <> 'user'");
  });
});
