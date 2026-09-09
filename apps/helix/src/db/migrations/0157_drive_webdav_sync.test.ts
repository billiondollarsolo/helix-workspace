import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "../../platform/drive/store.js";
import { tenantAwarePostgresSql } from "../../platform/tenancy/postgres-roles.js";

const migration = readFileSync(new URL("./0157_drive_webdav_sync.sql", import.meta.url), "utf8");

describe("0157 Drive WebDAV sync migration", () => {
  it("journals mutations atomically with bounded monotonic tenant collections", () => {
    expect(migration).toContain("primary key (org_id, collection_path_key, version)");
    expect(migration).toContain("version = drive_webdav_collections.version + 1");
    expect(migration).toContain("before insert or update or delete on objects");
    expect(migration).toContain("status smallint not null check (status in (200, 404))");
    expect(migration).toContain("version <= next_version - 10000");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("audience_actor_ids uuid[] not null");
    expect(migration).toContain("'file'::text, 200::smallint");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("durable Drive WebDAV sync journal", () => {
  const admin = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const role = "helix_webdav_sync_test_app";
  const password = "helix_webdav_sync_test_password";
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/helix");
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const runtime = postgres(runtimeUrl.toString(), { prepare: false });
  const store = new PostgresDriveStore(tenantAwarePostgresSql(runtime));
  const orgId = "f1570000-0000-4000-8000-000000000001";
  const ownerId = "f1570000-0000-4000-8000-000000000011";
  const readerId = "f1570000-0000-4000-8000-000000000012";
  const folderId = "f1570000-0000-4000-8000-000000000021";
  const objectId = "f1570000-0000-4000-8000-000000000031";

  async function cleanup() {
    await admin`delete from permissions where org_id = ${orgId}`;
    await admin`delete from objects where org_id = ${orgId}`;
    await admin`delete from drive_folders where org_id = ${orgId}`;
    await admin`delete from actors where org_id = ${orgId}`;
    await admin`delete from orgs where id = ${orgId}`;
  }

  beforeAll(async () => {
    const ready = await admin<{ ready: boolean }[]>`
      select to_regclass('public.drive_webdav_changes') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migration 0157 before this test.");
    await cleanup();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name)
      values (${orgId}, 'webdav-sync-test', 'WebDAV sync test')`;
    await admin`insert into actors (id, org_id, type, display_name)
      values (${ownerId}, ${orgId}, 'user', 'Owner'), (${readerId}, ${orgId}, 'user', 'Reader')`;
    await admin`insert into drive_folders (id, org_id, owner_actor_id, name)
      values (${folderId}, ${orgId}, ${ownerId}, 'Shared')`;
    await admin`insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    ) values (${orgId}, ${readerId}, 'drive_folder', ${folderId}, 'reader', ${ownerId})`;
  });

  afterAll(async () => {
    await cleanup();
    await runtime.end();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("emits inherited-access changes and tombstones while rollback emits nothing", async () => {
    await admin`insert into objects (
      id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
    ) values (
      ${objectId}, ${orgId}, ${ownerId}, 'file', 'webdav/v1', 'text/plain', 1, ${"a".repeat(64)},
      ${admin.json({ name: "note.txt", folderId, status: "ready" })}
    )`;
    const created = await store.listWebDavChanges({
      orgId,
      actorId: readerId,
      collectionPathKey: "/Shared",
      afterVersion: "0",
      limit: 250,
    });
    expect(created).toMatchObject({
      valid: true,
      changes: [{ pathKey: "/Shared/note.txt", resourceType: "file", status: 200, version: "1" }],
    });

    await expect(
      admin.begin(async (tx) => {
        await tx`update objects set storage_key = 'webdav/rolled-back' where id = ${objectId}`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      (
        await store.listWebDavChanges({
          orgId,
          actorId: readerId,
          collectionPathKey: "/Shared",
          afterVersion: "1",
          limit: 250,
        })
      ).changes,
    ).toEqual([]);

    await admin`update objects set deleted_at = statement_timestamp() where id = ${objectId}`;
    const deleted = await store.listWebDavChanges({
      orgId,
      actorId: readerId,
      collectionPathKey: "/Shared",
      afterVersion: "1",
      limit: 250,
    });
    expect(deleted).toMatchObject({
      version: "2",
      changes: [{ pathKey: "/Shared/note.txt", status: 404, version: "2" }],
    });
  });
});
