import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore, type DriveStorageClient } from "../../platform/drive/store.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../../platform/tenancy/postgres-roles.js";

const migration = readFileSync(
  new URL("./0141_drive_share_link_security.sql", import.meta.url),
  "utf8",
);

describe("0141 Drive share-link security migration", () => {
  it("keeps bearer material hashed and access evidence immutable", () => {
    expect(migration).toContain("drop column token");
    expect(migration).toContain("password_hash like '$argon2id$%'");
    expect(migration).toContain("helix_drive_share_link_by_token_hash");
    expect(migration).toContain("security definer");
    expect(migration).toContain("drive_share_link_events_no_update_or_delete");
    expect(migration).toContain("force row level security");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("Drive public share-link policy", () => {
  const admin = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const runtimeRole = "helix_drive_link_test_app";
  const runtimePassword = "helix_drive_link_test_password";
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/helix");
  runtimeUrl.username = runtimeRole;
  runtimeUrl.password = runtimePassword;
  const database = postgres(runtimeUrl.toString(), { prepare: false });
  const orgId = "f1410000-0000-4000-8000-000000000001";
  const actorId = "f1410000-0000-4000-8000-000000000011";
  const objectId = "f1410000-0000-4000-8000-000000000021";
  const bytes = Buffer.from("share-link bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `drive/${orgId}/${objectId}/v1/share.txt`;
  const storage: DriveStorageClient = {
    async put() {},
    async get(key) {
      return key === storageKey ? { key, body: bytes } : null;
    },
    async delete() {},
    async head(key) {
      return key === storageKey ? { key, byteSize: bytes.byteLength, metadata: { sha256 } } : null;
    },
  };
  const store = new PostgresDriveStore(tenantAwarePostgresSql(database), storage);

  async function cleanup() {
    await admin.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from drive_share_link_events where org_id = ${orgId}`;
      await tx`delete from drive_share_links where org_id = ${orgId}`;
      await tx`delete from activity where org_id = ${orgId}`;
      await tx`delete from objects where org_id = ${orgId}`;
      await tx`delete from organization_memberships where actor_id = ${actorId}`;
      await tx`delete from actors where id = ${actorId}`;
      await tx`delete from orgs where id = ${orgId}`;
    });
  }

  beforeAll(async () => {
    await cleanup();
    await admin.unsafe(`drop role if exists ${runtimeRole}`);
    await admin.unsafe(
      `create role ${runtimeRole} login inherit nosuperuser nobypassrls password '${runtimePassword}'`,
    );
    await admin.unsafe(`grant helix_app to ${runtimeRole}`);
    await admin`
      insert into orgs (id, slug, display_name)
      values (${orgId}, 'drive-links-security', 'Drive links security')
    `;
    await admin`
      insert into actors (id, org_id, type, display_name, email)
      values (${actorId}, ${orgId}, 'user', 'Link Owner', 'owner@example.test')
    `;
    await admin`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
      ) values (
        ${objectId}, ${orgId}, ${actorId}, 'file', ${storageKey}, 'text/plain',
        ${bytes.byteLength}, ${sha256}, '{"name":"share.txt","status":"ready"}'
      )
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
    await admin.unsafe(`drop role if exists ${runtimeRole}`);
    await admin.end();
  });

  it("creates a one-time reader token and never returns bearer material when listing", async () => {
    const link = await withTenantPostgresContext(database, { orgId, actorId }, () =>
      store.createShareLink({
        orgId,
        actorId,
        objectId,
        password: "correct horse battery staple",
        oneTime: true,
        allowedDomains: ["example.test"],
      }),
    );
    expect(link).toMatchObject({ role: "reader", oneTime: true, passwordProtected: true });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const stored = await admin<
      { readonly token_hash: string; readonly plaintext_column: boolean }[]
    >`
      select token_hash,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'drive_share_links'
            and column_name = 'token'
        ) as plaintext_column
      from drive_share_links where id = ${link.id}
    `;
    expect(stored[0]).toMatchObject({
      token_hash: createHash("sha256")
        .update(link.token ?? "")
        .digest("hex"),
      plaintext_column: false,
    });

    const listed = await withTenantPostgresContext(database, { orgId, actorId }, () =>
      store.listShareLinks({ orgId, actorId, objectId }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.token).toBeNull();

    const access = {
      token: link.token ?? "",
      actor: { id: actorId, orgId, email: "owner@example.test" },
      clientKey: "a".repeat(64),
    } as const;
    await expect(
      store.openFileByShareToken({ ...access, password: "wrong password" }),
    ).resolves.toBeNull();
    const opened = await store.openFileByShareToken({
      ...access,
      password: "correct horse battery staple",
    });
    expect(opened).not.toBeNull();
    await expect(opened?.open()).resolves.toEqual(bytes);
    await expect(
      store.openFileByShareToken({ ...access, password: "correct horse battery staple" }),
    ).resolves.toBeNull();

    const events = await admin<{ readonly event_type: string; readonly outcome: string }[]>`
      select event_type, outcome from drive_share_link_events
      where org_id = ${orgId} and link_id = ${link.id}
      order by created_at, id
    `;
    expect(events).toEqual(
      expect.arrayContaining([
        { event_type: "create", outcome: "allowed" },
        { event_type: "access", outcome: "denied" },
        { event_type: "access", outcome: "allowed" },
      ]),
    );
    await expect(
      admin`update drive_share_link_events set details = '{}' where link_id = ${link.id}`,
    ).rejects.toThrow("immutable");
  });
});
