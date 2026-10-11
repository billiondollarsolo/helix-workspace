import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "../../platform/drive/store.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../../platform/tenancy/postgres-roles.js";

const migration = readFileSync(
  new URL("./0210_drive_trash_retention_policy.sql", import.meta.url),
  "utf8",
);
const DAY_MS = 24 * 60 * 60 * 1000;

describe("0210 Drive trash retention policy migration", () => {
  it("reads the organization's retention instead of a fixed 30 days", () => {
    expect(migration).toContain("helix_drive_trash_retention_days(new.org_id)");
    expect(migration).toContain("from drive_lifecycle_policies policy");
    expect(migration).not.toContain("interval '30 days'");
    expect(migration).toContain("greatest(");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("Drive trash retention policy", () => {
  const database = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const store = new PostgresDriveStore(tenantAwarePostgresSql(database));
  const configuredOrg = "f2100000-0000-4000-8000-000000000001";
  const defaultOrg = "f2100000-0000-4000-8000-000000000002";
  const actors = {
    [configuredOrg]: "f2100000-0000-4000-8000-000000000011",
    [defaultOrg]: "f2100000-0000-4000-8000-000000000012",
  } as const;
  const objects = {
    [configuredOrg]: "f2100000-0000-4000-8000-000000000021",
    [defaultOrg]: "f2100000-0000-4000-8000-000000000022",
  } as const;
  const folderId = "f2100000-0000-4000-8000-000000000031";
  const orgs = [configuredOrg, defaultOrg] as const;

  async function cleanup() {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const orgId of orgs) {
        await tx`delete from activity where org_id = ${orgId}`;
        await tx`delete from objects where org_id = ${orgId}`;
        await tx`delete from drive_folders where org_id = ${orgId}`;
        await tx`delete from drive_lifecycle_policies where org_id = ${orgId}`;
        await tx`delete from organization_memberships where org_id = ${orgId}`;
        await tx`delete from actors where org_id = ${orgId}`;
        await tx`delete from orgs where id = ${orgId}`;
      }
    });
  }

  async function trashedDeadlineDays(table: "objects" | "drive_folders", id: string) {
    const rows = await database<
      { readonly deleted_at: Date; readonly trash_purge_after: Date }[]
    >`select deleted_at, trash_purge_after from ${database(table)} where id = ${id}`;
    const row = rows[0];
    if (row === undefined) throw new Error(`Missing ${table} row ${id}`);
    return (row.trash_purge_after.getTime() - row.deleted_at.getTime()) / DAY_MS;
  }

  beforeAll(async () => {
    await cleanup();
    for (const orgId of orgs) {
      const actorId = actors[orgId];
      await database`
        insert into orgs (id, slug, display_name)
        values (${orgId}, ${`drive-retention-${orgId.slice(-2)}`}, 'Drive retention policy')
      `;
      await database`
        insert into actors (id, org_id, type, display_name, email)
        values (${actorId}, ${orgId}, 'user', 'Drive Owner', ${`owner-${orgId.slice(-2)}@example.test`})
      `;
      await database`
        insert into objects (
          id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
        ) values (
          ${objects[orgId]}, ${orgId}, ${actorId}, 'file', ${`drive/retention/${orgId}`},
          'text/plain', 1, repeat('a', 64), '{"name":"policy.txt","status":"ready"}'
        )
      `;
    }
    await database`
      insert into drive_folders (id, org_id, name, owner_actor_id, created_by_actor_id)
      values (${folderId}, ${configuredOrg}, 'Old plans', ${actors[configuredOrg]}, ${actors[configuredOrg]})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("stamps trashed files and folders with the organization's retention", async () => {
    const orgId = configuredOrg;
    const actorId = actors[orgId];
    await withTenantPostgresContext(database, { orgId, actorId }, () =>
      store.setLifecyclePolicy({ orgId, actorId, trashRetentionDays: 7, orphanGraceHours: 24 }),
    );
    await withTenantPostgresContext(database, { orgId, actorId }, () =>
      store.trash({ orgId, actorId, objectId: objects[orgId] }),
    );
    expect(await trashedDeadlineDays("objects", objects[orgId])).toBe(7);

    await database`update drive_folders set deleted_at = now() where id = ${folderId}`;
    expect(await trashedDeadlineDays("drive_folders", folderId)).toBe(7);
  });

  it("keeps 30 days for organizations without a policy", async () => {
    const orgId = defaultOrg;
    const actorId = actors[orgId];
    await withTenantPostgresContext(database, { orgId, actorId }, () =>
      store.trash({ orgId, actorId, objectId: objects[orgId] }),
    );
    expect(await trashedDeadlineDays("objects", objects[orgId])).toBe(30);
  });
});
