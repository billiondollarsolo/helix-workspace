import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "../../platform/drive/store.js";
import { tenantAwarePostgresSql } from "../../platform/tenancy/postgres-roles.js";

const migration = readFileSync(new URL("./0146_drive_webdav_locks.sql", import.meta.url), "utf8");

describe("0146 Drive WebDAV locks migration", () => {
  it("stores tenant/actor-bound expiring locks with monotonic fences and forced RLS", () => {
    expect(migration).toContain("foreign key (org_id, actor_id) references actors(org_id, id)");
    expect(migration).toContain("fence bigint generated always as identity unique");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("actor_id = helix_current_actor_id()");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("durable Drive WebDAV locks", () => {
  const admin = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const role = "helix_webdav_lock_test_app";
  const password = "helix_webdav_lock_test_password";
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/helix");
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const runtime = postgres(runtimeUrl.toString(), { prepare: false });
  const storeA = new PostgresDriveStore(tenantAwarePostgresSql(runtime));
  const storeB = new PostgresDriveStore(tenantAwarePostgresSql(runtime));
  const orgId = "f1460000-0000-4000-8000-000000000001";
  const actorA = "f1460000-0000-4000-8000-000000000011";
  const actorB = "f1460000-0000-4000-8000-000000000012";

  async function cleanup() {
    await admin`delete from drive_webdav_locks where org_id = ${orgId}`;
    await admin`delete from actors where org_id = ${orgId}`;
    await admin`delete from orgs where id = ${orgId}`;
  }

  beforeAll(async () => {
    await cleanup();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name)
      values (${orgId}, 'webdav-lock-test', 'WebDAV lock test')`;
    await admin`insert into actors (id, org_id, type, display_name)
      values (${actorA}, ${orgId}, 'user', 'Actor A'), (${actorB}, ${orgId}, 'user', 'Actor B')`;
  });

  afterAll(async () => {
    await cleanup();
    await runtime.end();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("survives store instances, fences conflicts, and binds release to the actor", async () => {
    const lock = await storeA.acquireWebDavLock({
      orgId,
      actorId: actorA,
      pathKey: "/Projects",
      owner: "Actor A",
      depth: "infinity",
      timeoutSeconds: 60,
    });
    expect(lock).not.toBeNull();
    await expect(
      storeB.listWebDavLocks({ orgId, actorId: actorB, pathKeys: ["/Projects/report.txt"] }),
    ).resolves.toMatchObject([{ token: lock?.token, actorId: actorA }]);
    await expect(
      storeB.acquireWebDavLock({
        orgId,
        actorId: actorB,
        pathKey: "/Projects/report.txt",
        owner: "Actor B",
        depth: "0",
        timeoutSeconds: 60,
      }),
    ).resolves.toBeNull();
    await expect(
      storeB.releaseWebDavLock({
        orgId,
        actorId: actorB,
        pathKey: "/Projects",
        token: lock?.token ?? "",
      }),
    ).resolves.toBe(false);
    await expect(
      storeA.releaseWebDavLock({
        orgId,
        actorId: actorA,
        pathKey: "/Projects",
        token: lock?.token ?? "",
      }),
    ).resolves.toBe(true);
  });
});
