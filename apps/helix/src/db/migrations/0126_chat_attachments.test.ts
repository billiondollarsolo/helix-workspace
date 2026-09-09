import { readFile } from "node:fs/promises";
import type { StorageClient, StorageObject } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChatAttachmentStore } from "../../platform/chat/attachments.js";
import { PostgresDriveStore } from "../../platform/drive/store.js";
import { createDefaultTenantStorageResolver } from "../../platform/storage/tenant-resolver.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 3 });

describe("0126 Chat attachments", () => {
  it("defines a hidden, room-authorized, scanned and purgeable object namespace", async () => {
    const migration = await readFile(
      new URL("./0126_chat_attachments.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("add value if not exists 'chat_attachment'");
    expect(migration).toContain("byte_size between 1 and 10485760");
    expect(migration).toContain("helix_chat_attachment_room_access");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("message_attachments_bind_chat_object");
    expect(migration).toContain("chat_attachments_queue_byte_purge");
    expect(migration).toContain("helix_storage_usage_bytes");
  });
});

describe.skipIf(sql === null)("0126 live Chat attachment isolation", () => {
  const database = sql as postgres.Sql;
  const orgA = "ca190000-0000-4000-8000-000000000001";
  const orgB = "ca190000-0000-4000-8000-000000000002";
  const owner = "ca190000-0000-4000-8000-000000000011";
  const member = "ca190000-0000-4000-8000-000000000012";
  const outsider = "ca190000-0000-4000-8000-000000000013";
  const otherTenant = "ca190000-0000-4000-8000-000000000014";
  const room = "ca190000-0000-4000-8000-000000000021";
  const otherRoom = "ca190000-0000-4000-8000-000000000022";
  const object = "ca190000-0000-4000-8000-000000000031";
  const protectedStage = "ca190000-0000-4000-8000-000000000032";
  const hash = "a".repeat(64);

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name, status, tier, region) values
        (${orgA}, 'chat19-a', 'CHAT 19 A', 'active', 'business', 'test'),
        (${orgB}, 'chat19-b', 'CHAT 19 B', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name) values
        (${owner}, ${orgA}, 'user', 'Owner'),
        (${member}, ${orgA}, 'user', 'Member'),
        (${outsider}, ${orgA}, 'user', 'Outsider'),
        (${otherTenant}, ${orgB}, 'user', 'Other tenant')
    `;
    await database`
      insert into threads (id, org_id, kind, subject, created_by_actor_id) values
        (${room}, ${orgA}, 'chat_room', 'Media', ${owner}),
        (${otherRoom}, ${orgA}, 'chat_room', 'Other room', ${owner})
    `;
    await database`
      insert into chat_room_settings (thread_id, org_id) values
        (${room}, ${orgA}), (${otherRoom}, ${orgA})
    `;
    await database`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values
        (${orgA}, ${owner}, 'thread', ${room}, 'owner', ${owner}),
        (${orgA}, ${member}, 'thread', ${room}, 'member', ${owner}),
        (${orgA}, ${owner}, 'thread', ${otherRoom}, 'owner', ${owner})
    `;
    for (const objectId of [object, protectedStage]) {
      await database`
        insert into objects (
          id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
        ) values (
          ${objectId}, ${orgA}, ${owner}, 'chat_attachment',
          ${`chat/attachments/${room}/${objectId}/${hash}`}, 'image/png', 8, ${hash},
          '{"namespace":"chat_attachment","status":"ready"}'::jsonb
        )
      `;
      await database`
        insert into chat_attachments (
          object_id, org_id, room_id, owner_actor_id, filename, mime_type,
          byte_size, sha256, status, scanned_at, expires_at
        ) values (
          ${objectId}, ${orgA}, ${room}, ${owner}, 'paste.png', 'image/png',
          8, ${hash}, 'ready', now(), now() + interval '1 hour'
        )
      `;
      await database`
        insert into drive_quarantine_deletions (
          org_id, object_id, actor_id, storage_key, status, next_attempt_at
        ) values (
          ${orgA}, ${objectId}, ${owner},
          ${`chat/attachments/${room}/${objectId}/${hash}`}, 'pending', now() + interval '1 hour'
        )
      `;
    }
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("hides an unbound stage from room peers and every outsider", async () => {
    await expect(visibleAttachments(owner)).resolves.toEqual([object, protectedStage]);
    await expect(visibleAttachments(member)).resolves.toEqual([]);
    await expect(visibleAttachments(outsider)).resolves.toEqual([]);
    await expect(visibleAttachments(otherTenant, orgB)).resolves.toEqual([]);
    await expect(
      new PostgresDriveStore(database)
        .list({ orgId: orgA, actorId: owner, acrossFolders: true })
        .then(({ entries }) => entries),
    ).resolves.toEqual([]);
  });

  it("uploads through the tenant-private namespace and exposes bytes only after room binding", async () => {
    const stored = new Map<string, StorageObject>();
    const storage = {
      async put(value) {
        if (!(value.body instanceof Uint8Array)) throw new Error("Expected bounded upload bytes.");
        stored.set(value.key, { ...value, body: Buffer.from(value.body) });
      },
      async get(key) {
        return stored.get(key) ?? null;
      },
      async delete(key) {
        stored.delete(key);
      },
    } satisfies StorageClient;
    const attachmentStore = new PostgresChatAttachmentStore(database, {
      storageResolver: createDefaultTenantStorageResolver(storage, {
        serverSideEncryption: "AES256",
      }),
      virusScanner: { scan: async () => ({ clean: true }) },
    });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await attachmentStore.upload({
      orgId: orgA,
      actorId: owner,
      roomId: room,
      filename: "pasted.png",
      declaredMimeType: "image/png",
      bytes,
    });
    expect([...stored.keys()]).toEqual([
      expect.stringMatching(
        new RegExp(
          `^tenants/${orgA}/chat/attachments/${room}/${uploaded.objectId}/[a-f0-9]{64}$`,
          "u",
        ),
      ),
    ]);
    await expect(
      attachmentStore.open({ orgId: orgA, actorId: member, objectId: uploaded.objectId }),
    ).rejects.toThrow("Chat attachment not found");

    const messageId = await asActor(owner, async (tx) => {
      const rows = await tx<{ readonly id: string }[]>`
        insert into messages (org_id, thread_id, actor_id, kind, body, body_format)
        values (${orgA}, ${room}, ${owner}, 'chat', '', 'plain') returning id
      `;
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("Expected message id.");
      await tx`
        insert into message_attachments (org_id, message_id, object_id, disposition)
        values (${orgA}, ${id}, ${uploaded.objectId}, 'attachment')
      `;
      return id;
    });
    await expect(
      attachmentStore.open({ orgId: orgA, actorId: member, objectId: uploaded.objectId }),
    ).resolves.toMatchObject({ bytes, source: "chat" });
    await expect(
      attachmentStore.open({ orgId: orgA, actorId: outsider, objectId: uploaded.objectId }),
    ).rejects.toThrow("Chat attachment not found");
    const driveEntries = await new PostgresDriveStore(database).list({
      orgId: orgA,
      actorId: owner,
      acrossFolders: true,
    });
    expect(driveEntries.entries.map(({ id }) => id)).not.toContain(uploaded.objectId);
    await database`delete from messages where org_id = ${orgA} and id = ${messageId}`;
  });

  it("atomically binds only the sender's ready stage in its original room", async () => {
    const messageId = await asActor(owner, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into messages (org_id, thread_id, actor_id, kind, body, body_format)
        values (${orgA}, ${room}, ${owner}, 'chat', '', 'plain') returning id
      `;
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("Expected message id.");
      await tx`
        insert into message_attachments (org_id, message_id, object_id, disposition)
        values (${orgA}, ${id}, ${object}, 'attachment')
      `;
      return id;
    });

    await expect(visibleAttachments(member)).resolves.toEqual([object]);
    await expect(visibleAttachments(outsider)).resolves.toEqual([]);
    await expect(
      database<{ count: number }[]>`
        select count(*)::integer count from drive_quarantine_deletions
        where org_id = ${orgA} and object_id = ${object}
      `,
    ).resolves.toEqual([{ count: 0 }]);

    await database`
      update chat_attachments set expires_at = now() - interval '1 second'
      where org_id = ${orgA} and object_id = ${protectedStage}
    `;
    await expect(visibleAttachments(owner)).resolves.toEqual([object]);

    await expect(
      asActor(member, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          insert into messages (org_id, thread_id, actor_id, kind, body, body_format)
          values (${orgA}, ${room}, ${member}, 'chat', 'forged', 'plain') returning id
        `;
        return tx`
          insert into message_attachments (org_id, message_id, object_id)
          values (${orgA}, ${rows[0]?.id ?? ""}, ${protectedStage})
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await database`delete from messages where org_id = ${orgA} and id = ${messageId}`;
    await expect(
      database<{ status: string }[]>`
        select status from drive_quarantine_deletions
        where org_id = ${orgA} and object_id = ${object}
      `,
    ).resolves.toEqual([{ status: "pending" }]);
  });

  it("forces RLS and refuses cross-tenant quota inspection", async () => {
    const catalog = await database<
      {
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        worker_can_mutate: boolean;
      }[]
    >`
      select relrowsecurity, relforcerowsecurity,
        has_table_privilege('helix_worker', oid, 'insert,update,delete') worker_can_mutate
      from pg_class where relname = 'chat_attachments'
    `;
    expect(catalog).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true, worker_can_mutate: false },
    ]);
    await expect(
      asActor(owner, (tx) => tx`select helix_storage_usage_bytes(${orgB})`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  async function visibleAttachments(actorId: string, actorOrgId = orgA): Promise<string[]> {
    const rows = await asActor(
      actorId,
      (tx) =>
        tx<{ object_id: string }[]>`select object_id from chat_attachments order by object_id`,
      actorOrgId,
    );
    return rows.map(({ object_id }) => object_id);
  }

  async function asActor<T>(
    actorId: string,
    callback: (tx: postgres.TransactionSql) => Promise<T>,
    actorOrgId = orgA,
  ): Promise<T> {
    return database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`
        select set_config('helix.org_id', ${actorOrgId}, true),
          set_config('helix.actor_id', ${actorId}, true)
      `;
      return callback(tx);
    }) as Promise<T>;
  }

  async function cleanup(): Promise<void> {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from drive_quarantine_deletions where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_room_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from message_attachments where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_attachments where org_id in (${orgA}, ${orgB})`;
      await tx`delete from messages where org_id in (${orgA}, ${orgB})`;
      await tx`delete from objects where org_id in (${orgA}, ${orgB})`;
      await tx`delete from permissions where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_room_settings where org_id in (${orgA}, ${orgB})`;
      await tx`delete from threads where org_id in (${orgA}, ${orgB})`;
      await tx`delete from organization_memberships where org_id in (${orgA}, ${orgB})`;
      await tx`delete from actors where id in (${owner}, ${member}, ${outsider}, ${otherTenant})`;
      await tx`delete from orgs where id in (${orgA}, ${orgB})`;
    });
  }
});
