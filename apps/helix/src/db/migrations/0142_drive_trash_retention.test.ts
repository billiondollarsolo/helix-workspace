import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DriveConflictError } from "../../platform/drive/errors.js";
import { PostgresDriveStore } from "../../platform/drive/store.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../../platform/tenancy/postgres-roles.js";

const migration = readFileSync(
  new URL("./0142_drive_trash_retention.sql", import.meta.url),
  "utf8",
);

describe("0142 Drive trash retention migration", () => {
  it("defines a recovery deadline, explicit retention, and tenant-scoped holds", () => {
    expect(migration).toContain("new.deleted_at + interval '30 days'");
    expect(migration).toContain("create table drive_retention_holds");
    expect(migration).toContain("drive_retention_holds_active_idx");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("Drive hold object must belong to its tenant");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("Drive trash lifecycle", () => {
  const database = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const store = new PostgresDriveStore(tenantAwarePostgresSql(database));
  const orgId = "f1420000-0000-4000-8000-000000000001";
  const actorId = "f1420000-0000-4000-8000-000000000011";
  const objectId = "f1420000-0000-4000-8000-000000000021";

  async function scoped<T>(run: () => Promise<T>): Promise<T> {
    return withTenantPostgresContext(database, { orgId, actorId }, run);
  }

  async function cleanup() {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from drive_retention_holds where org_id = ${orgId}`;
      await tx`delete from activity where org_id = ${orgId}`;
      await tx`delete from objects where org_id = ${orgId}`;
      await tx`delete from organization_memberships where actor_id = ${actorId}`;
      await tx`delete from actors where id = ${actorId}`;
      await tx`delete from orgs where id = ${orgId}`;
    });
  }

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name)
      values (${orgId}, 'drive-retention', 'Drive retention')
    `;
    await database`
      insert into actors (id, org_id, type, display_name, email)
      values (${actorId}, ${orgId}, 'user', 'Drive Owner', 'owner@example.test')
    `;
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
      ) values (
        ${objectId}, ${orgId}, ${actorId}, 'file', 'drive/retention/file', 'text/plain',
        1, repeat('a', 64), '{"name":"retained.txt","status":"ready"}'
      )
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("blocks active, young, retained, and held content; restores only during recovery", async () => {
    await expect(scoped(() => store.delete({ orgId, actorId, objectId }))).rejects.toBeInstanceOf(
      DriveConflictError,
    );

    await expect(scoped(() => store.trash({ orgId, actorId, objectId }))).resolves.toMatchObject({
      id: objectId,
      deletedAt: expect.any(Date),
    });
    const deadline = await database<
      { readonly deleted_at: Date; readonly trash_purge_after: Date }[]
    >`
      select deleted_at, trash_purge_after from objects where id = ${objectId}
    `;
    expect(deadline[0]?.trash_purge_after.getTime()).toBe(
      (deadline[0]?.deleted_at.getTime() ?? 0) + 30 * 24 * 60 * 60 * 1000,
    );
    await expect(scoped(() => store.delete({ orgId, actorId, objectId }))).rejects.toThrow(
      "recovery window",
    );

    await expect(scoped(() => store.restore({ orgId, actorId, objectId }))).resolves.toMatchObject({
      id: objectId,
      deletedAt: null,
    });
    await scoped(() => store.trash({ orgId, actorId, objectId }));
    await database`
      update objects set deleted_at = now() - interval '31 days' where id = ${objectId}
    `;
    await database`
      insert into drive_retention_holds (
        org_id, resource_type, resource_id, reason, created_by_actor_id
      ) values (${orgId}, 'object', ${objectId}, 'legal discovery', ${actorId})
    `;
    await expect(scoped(() => store.delete({ orgId, actorId, objectId }))).rejects.toThrow(
      "retention hold",
    );

    await database`
      update drive_retention_holds
      set released_at = now(), released_by_actor_id = ${actorId}
      where org_id = ${orgId} and resource_id = ${objectId}
    `;
    await database`
      update objects set retain_until = now() + interval '1 day' where id = ${objectId}
    `;
    await expect(scoped(() => store.delete({ orgId, actorId, objectId }))).rejects.toThrow(
      "retention policy",
    );

    await database`update objects set retain_until = null where id = ${objectId}`;
    await expect(scoped(() => store.delete({ orgId, actorId, objectId }))).resolves.toBe(true);
  });
});
