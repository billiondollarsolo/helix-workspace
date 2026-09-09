import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { StorageObject } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChatAttachmentStore } from "../../platform/chat/attachments.js";
import { createDefaultTenantStorageResolver } from "../../platform/storage/tenant-resolver.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 2 });

describe("0140 Chat attachment delete lifecycle", () => {
  it("revokes tombstoned media and queues its object for durable purge", async () => {
    const migration = await readFile(
      new URL("./0140_chat_attachment_delete_lifecycle.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("message.deleted_at is null");
    expect(migration).toContain("messages_revoke_deleted_chat_attachments");
    expect(migration).toContain("delete from public.chat_attachments");
  });
});

describe.skipIf(sql === null)("0140 live Chat attachment revocation", () => {
  const database = sql as postgres.Sql;
  const orgId = "ca200000-0000-4000-8000-000000000001";
  const actorId = "ca200000-0000-4000-8000-000000000011";
  const roomId = "ca200000-0000-4000-8000-000000000021";
  const messageId = "ca200000-0000-4000-8000-000000000031";
  const objectId = "ca200000-0000-4000-8000-000000000041";
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `chat/attachments/${roomId}/${objectId}/${hash}`;
  const stored = new Map<string, StorageObject>([
    [
      `tenants/${orgId}/${storageKey}`,
      { key: `tenants/${orgId}/${storageKey}`, body: bytes, contentType: "image/png" },
    ],
  ]);
  const attachments = new PostgresChatAttachmentStore(database, {
    storageResolver: createDefaultTenantStorageResolver(
      {
        async put(value) {
          stored.set(value.key, value);
        },
        async get(key) {
          return stored.get(key) ?? null;
        },
        async delete(key) {
          stored.delete(key);
        },
      },
      { serverSideEncryption: "AES256" },
    ),
  });

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name) values (${orgId}, 'chat-0140', 'Chat 0140')
    `;
    await database`
      insert into actors (id, org_id, type, display_name)
      values (${actorId}, ${orgId}, 'user', 'Chat owner')
    `;
    await database`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${roomId}, ${orgId}, 'chat_room', 'Media', ${actorId})
    `;
    await database`
      insert into chat_room_settings (thread_id, org_id) values (${roomId}, ${orgId})
    `;
    await database`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${orgId}, ${actorId}, 'thread', ${roomId}, 'owner', ${actorId})
    `;
    await database`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format)
      values (${messageId}, ${orgId}, ${roomId}, ${actorId}, 'chat', '', 'plain')
    `;
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
      ) values (
        ${objectId}, ${orgId}, ${actorId}, 'chat_attachment', ${storageKey},
        'image/png', 8, ${hash}, '{"status":"ready"}'::jsonb
      )
    `;
    await database`
      insert into chat_attachments (
        object_id, org_id, room_id, owner_actor_id, message_id, filename,
        mime_type, byte_size, sha256, status, scanned_at, expires_at
      ) values (
        ${objectId}, ${orgId}, ${roomId}, ${actorId}, ${messageId}, 'paste.png',
        'image/png', 8, ${hash}, 'ready', now(), 'infinity'
      )
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("makes a known object unreadable and schedules byte cleanup on soft delete", async () => {
    await expect(canRead()).resolves.toBe(true);
    await expect(attachments.open({ orgId, actorId, objectId })).resolves.toMatchObject({ bytes });

    await database`update messages set deleted_at = now() where org_id = ${orgId} and id = ${messageId}`;

    await expect(canRead()).resolves.toBe(false);
    await expect(attachments.open({ orgId, actorId, objectId })).rejects.toThrow(
      "Chat attachment not found",
    );
    await expect(
      database`select object_id from chat_attachments where org_id = ${orgId} and object_id = ${objectId}`,
    ).resolves.toEqual([]);
    await expect(
      database`
        select object_id, storage_key, status
        from drive_quarantine_deletions
        where org_id = ${orgId} and object_id = ${objectId}
      `,
    ).resolves.toEqual([{ object_id: objectId, storage_key: storageKey, status: "pending" }]);
  });

  async function canRead(): Promise<boolean> {
    return database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`
        select set_config('helix.org_id', ${orgId}, true),
          set_config('helix.actor_id', ${actorId}, true)
      `;
      const rows = await tx<{ allowed: boolean }[]>`
        select helix_can_read_chat_attachment(${orgId}, ${objectId}) allowed
      `;
      return rows[0]?.allowed ?? false;
    });
  }

  async function cleanup(): Promise<void> {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from drive_quarantine_deletions where org_id = ${orgId}`;
      await tx`delete from chat_room_events where org_id = ${orgId}`;
      await tx`delete from chat_attachments where org_id = ${orgId}`;
      await tx`delete from chat_message_revisions where org_id = ${orgId}`;
      await tx`delete from messages where org_id = ${orgId}`;
      await tx`delete from objects where org_id = ${orgId}`;
      await tx`delete from permissions where org_id = ${orgId}`;
      await tx`delete from chat_room_settings where org_id = ${orgId}`;
      await tx`delete from threads where org_id = ${orgId}`;
      await tx`delete from organization_memberships where org_id = ${orgId}`;
      await tx`delete from actors where org_id = ${orgId}`;
      await tx`delete from orgs where id = ${orgId}`;
      await tx`delete from identity_subjects where id = ${actorId}`;
    });
  }
});
