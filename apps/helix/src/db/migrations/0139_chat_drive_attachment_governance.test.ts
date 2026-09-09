import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChatStore } from "../../platform/chat/store.js";

const migration = readFileSync(
  new URL("./0139_chat_drive_attachment_governance.sql", import.meta.url),
  "utf8",
);

describe("0139 Chat Drive attachment governance migration", () => {
  it("enforces one current-ACL link path with a non-secret durable snapshot", () => {
    expect(migration).toContain("drive_comment_actor_role_rank");
    expect(migration).toContain("Drive attachment is not clean and ready");
    expect(migration).toContain("classified Drive attachment cannot enter an external room");
    expect(migration).toContain("Drive attachment has no passing DLP verdict");
    expect(migration).toContain("'versionId', target_object.metadata->>'latestVersionId'");
    expect(migration).not.toContain("'storageKey'");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("Chat Drive attachment policy", () => {
  const database = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const store = new PostgresChatStore(database);
  const org = "f1390000-0000-4000-8000-000000000001";
  const otherOrg = "f1390000-0000-4000-8000-000000000002";
  const sender = "f1390000-0000-4000-8000-000000000011";
  const guest = "f1390000-0000-4000-8000-000000000012";
  const room = "f1390000-0000-4000-8000-000000000021";
  const clean = "f1390000-0000-4000-8000-000000000031";
  const dirty = "f1390000-0000-4000-8000-000000000032";
  const revoked = "f1390000-0000-4000-8000-000000000033";
  const restricted = "f1390000-0000-4000-8000-000000000034";
  const unscanned = "f1390000-0000-4000-8000-000000000035";
  const foreign = "f1390000-0000-4000-8000-000000000036";

  async function cleanup() {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from chat_room_events where org_id in (${org}, ${otherOrg})`;
      await tx`
        delete from message_attachments where message_id in (
          select id from messages where org_id in (${org}, ${otherOrg})
        )
      `;
      await tx`delete from messages where org_id in (${org}, ${otherOrg})`;
      await tx`delete from permissions where org_id in (${org}, ${otherOrg})`;
      await tx`delete from resource_classifications where org_id in (${org}, ${otherOrg})`;
      await tx`delete from admin_security_policies where org_id in (${org}, ${otherOrg})`;
      await tx`delete from objects where org_id in (${org}, ${otherOrg})`;
      await tx`delete from chat_room_settings where org_id in (${org}, ${otherOrg})`;
      await tx`delete from threads where org_id in (${org}, ${otherOrg})`;
      await tx`delete from organization_memberships where actor_id in (${sender}, ${guest})`;
      await tx`delete from actors where id in (${sender}, ${guest})`;
      await tx`delete from orgs where id in (${org}, ${otherOrg})`;
    });
  }

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name) values
        (${org}, 'chat-drive-policy', 'Chat Drive Policy'),
        (${otherOrg}, 'chat-drive-policy-other', 'Chat Drive Policy Other')
    `;
    await database`
      insert into actors (id, org_id, type, display_name, email) values
        (${sender}, ${org}, 'user', 'Sender', 'sender@example.test'),
        (${guest}, ${org}, 'user', 'Guest', 'guest@partner.test')
    `;
    await database`
      update organization_memberships set guest_type = 'external' where actor_id = ${guest}
    `;
    await database`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${room}, ${org}, 'chat_room', 'External room', ${sender})
    `;
    await database`
      insert into chat_room_settings (thread_id, org_id, participant_key)
      values (${room}, ${org}, null)
    `;
    await database`
      insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values
        (${org}, ${sender}, 'thread', ${room}, 'owner', ${sender}),
        (${org}, ${guest}, 'thread', ${room}, 'member', ${sender})
    `;
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
      ) values
        (${clean}, ${org}, ${sender}, 'file', 'drive/clean', 'image/png', 10, repeat('a', 64),
          '{"name":"clean.png","status":"ready","latestVersionId":"v1","dlpVerdict":"clean"}'),
        (${dirty}, ${org}, ${sender}, 'file', 'drive/dirty', 'image/png', 11, repeat('b', 64),
          '{"name":"dirty.png","status":"scan_pending"}'),
        (${revoked}, ${org}, ${guest}, 'file', 'drive/revoked', 'text/plain', 12, repeat('c', 64),
          '{"name":"revoked.txt","status":"ready","dlpVerdict":"clean"}'),
        (${restricted}, ${org}, ${sender}, 'file', 'drive/restricted', 'text/plain', 13, repeat('d', 64),
          '{"name":"restricted.txt","status":"ready","dlpVerdict":"clean"}'),
        (${unscanned}, ${org}, ${sender}, 'file', 'drive/unscanned', 'text/plain', 14, repeat('e', 64),
          '{"name":"unscanned.txt","status":"ready"}'),
        (${foreign}, ${otherOrg}, null, 'file', 'drive/foreign', 'text/plain', 15, repeat('f', 64),
          '{"name":"foreign.txt","status":"ready","dlpVerdict":"clean"}')
    `;
    await database`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
        status, revoked_at, revocation_epoch
      ) values (${org}, ${sender}, 'object', ${revoked}, 'reader', ${guest}, 'revoked', now(), 1)
    `;
    await database`
      insert into resource_classifications (
        org_id, resource_type, resource_id, classification, source, reason, actor_id
      ) values (${org}, 'drive.file', ${restricted}, 'restricted', 'explicit', 'policy test', ${sender})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  async function send(objectId: string, clientMessageId: string) {
    return store.withActorContext({ orgId: org, actorId: sender }, (scoped) =>
      scoped.sendMessage({
        orgId: org,
        actorId: sender,
        roomId: room,
        body: "Drive attachment",
        attachmentObjectIds: [objectId],
        clientMessageId,
      }),
    );
  }

  it("stores a stable metadata snapshot while retaining current-ACL content semantics", async () => {
    const message = await send(clean, "chat-drive-clean");
    const rows = await database<
      { readonly snapshot: Record<string, unknown>; readonly access_mode: string }[]
    >`
      select snapshot, access_mode from message_attachments
      where org_id = ${org} and message_id = ${message.id} and object_id = ${clean}
    `;
    expect(rows[0]).toMatchObject({
      access_mode: "current_acl",
      snapshot: {
        filename: "clean.png",
        mimeType: "image/png",
        byteSize: 10,
        classification: "standard",
        versionId: "v1",
      },
    });
  });

  it("rejects foreign, unclean, revoked, and externally prohibited objects", async () => {
    await expect(send(foreign, "chat-drive-foreign")).rejects.toThrow();
    await expect(send(dirty, "chat-drive-dirty")).rejects.toThrow("not clean and ready");
    await expect(send(revoked, "chat-drive-revoked")).rejects.toThrow("inaccessible");
    await expect(send(restricted, "chat-drive-restricted")).rejects.toThrow(
      "classified Drive attachment",
    );
  });

  it("fails closed when an enabled blocking DLP policy has no passing verdict", async () => {
    await database`
      insert into admin_security_policies (org_id, policy_type, enabled, enforcement, settings)
      values (
        ${org}, 'dlp', true, 'required',
        '{"action":"block","scanSharedDocs":true,"scanOutboundMail":true,"detectors":["pii"]}'
      )
    `;
    await expect(send(unscanned, "chat-drive-unscanned")).rejects.toThrow("DLP verdict");
    await expect(send(clean, "chat-drive-clean-dlp")).resolves.toMatchObject({ roomId: room });
  });
});
