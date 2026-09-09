import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMailStore } from "../../platform/mail/store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 3 });

describe("0135 mail trash retention migration", () => {
  it("defines reversible deadlines, holds, bounded purge, and durable byte cleanup", async () => {
    const migration = await readFile(
      new URL("./0135_mail_trash_retention.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("trash_purge_after = deleted_at + interval '30 days'");
    expect(migration).toContain("create table mail_retention_holds");
    expect(migration).toContain("limit batch_limit");
    expect(migration).toContain("for update of state skip locked");
    expect(migration).toContain("insert into public.drive_quarantine_deletions");
    expect(migration).toContain("object.kind::text in ('mail_attachment', 'mail_source')");
  });
});

describe.skipIf(sql === null)("0135 live mail trash lifecycle", () => {
  const database = sql as postgres.Sql;
  const orgId = "aa230000-0000-4000-8000-000000000001";
  const actorA = "aa230000-0000-4000-8000-000000000011";
  const actorB = "aa230000-0000-4000-8000-000000000012";
  const threadId = "aa230000-0000-4000-8000-000000000021";
  const messageId = "aa230000-0000-4000-8000-000000000031";
  const attachmentId = "aa230000-0000-4000-8000-000000000041";
  const sourceId = "aa230000-0000-4000-8000-000000000042";
  const driveFileId = "aa230000-0000-4000-8000-000000000043";
  const stageId = "aa230000-0000-4000-8000-000000000051";
  const providerId = "aa230000-0000-4000-8000-000000000061";
  const outboundId = "aa230000-0000-4000-8000-000000000062";
  const deliveryEventId = "aa230000-0000-4000-8000-000000000063";
  const suppressionId = "aa230000-0000-4000-8000-000000000064";
  const hash = "a".repeat(64);
  const dueBefore = new Date("2026-03-01T00:00:00.000Z");
  const store = new PostgresMailStore(database);

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values (${orgId}, 'mail23', 'Mail 23', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name) values
        (${actorA}, ${orgId}, 'user', 'Mailbox A'),
        (${actorB}, ${orgId}, 'user', 'Mailbox B')
    `;
    await database`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${threadId}, ${orgId}, 'mail', 'Retained message', ${actorA})
    `;
    await database`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format)
      values (${messageId}, ${orgId}, ${threadId}, ${actorA}, 'mail', 'private body', 'plain')
    `;
    await database`
      insert into mail_message_deliveries (org_id, message_id, actor_id) values
        (${orgId}, ${messageId}, ${actorA}),
        (${orgId}, ${messageId}, ${actorB})
    `;
    await database`
      insert into mail_thread_state (org_id, actor_id, thread_id, deleted_at) values
        (${orgId}, ${actorA}, ${threadId}, '2026-01-01T00:00:00.000Z'),
        (${orgId}, ${actorB}, ${threadId}, null)
    `;
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
      ) values
        (${attachmentId}, ${orgId}, ${actorA}, 'mail_attachment', 'mail/a',
          'text/plain', 1, ${hash}, '{}'),
        (${sourceId}, ${orgId}, ${actorA}, 'mail_source', 'mail/source',
          'message/rfc822', 1, ${hash}, '{}'),
        (${driveFileId}, ${orgId}, ${actorA}, 'file', 'drive/shared',
          'text/plain', 1, ${hash}, '{}')
    `;
    await database`
      insert into mail_attachment_ingestions (
        id, org_id, owner_actor_id, object_id, status, storage_key, declared_mime_type,
        expected_byte_size, actual_byte_size, expected_sha256, actual_sha256,
        scan_evidence, expires_at
      ) values (
        ${stageId}, ${orgId}, ${actorA}, ${attachmentId}, 'clean', 'mail/a', 'text/plain',
        1, 1, ${hash}, ${hash}, '{"scanned":true}', now() + interval '1 hour'
      )
    `;
    await database`
      insert into message_attachments (org_id, message_id, object_id) values
        (${orgId}, ${messageId}, ${attachmentId}),
        (${orgId}, ${messageId}, ${driveFileId})
    `;
    await database`
      insert into mail_raw_sources (
        message_id, org_id, object_id, parser, projection_version, projection, projection_sha256
      ) values (${messageId}, ${orgId}, ${sourceId}, 'mailparser', 1, '{}', ${hash})
    `;
    await database`
      insert into mail_outbound_providers (id, org_id, name, kind, config, created_by)
      values (${providerId}, ${orgId}, 'SMTP', 'smtp', '{}', ${actorA})
    `;
    await database`
      insert into mail_outbound_messages (
        id, org_id, actor_id, message_id, thread_id, status, envelope, undo_until
      ) values (
        ${outboundId}, ${orgId}, ${actorA}, ${messageId}, ${threadId}, 'bounced', '{}',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database`
      insert into mail_delivery_events (
        id, org_id, provider_id, outbound_id, provider_event_id, source, kind,
        retry_class, recipient, occurred_at
      ) values (
        ${deliveryEventId}, ${orgId}, ${providerId}, ${outboundId}, 'bounce-1', 'provider',
        'bounced', 'permanent', 'recipient@example.test', '2026-01-02T00:00:00.000Z'
      )
    `;
    await database`
      insert into mail_suppressions (id, org_id, address, reason, source_event_id)
      values (
        ${suppressionId}, ${orgId}, 'recipient@example.test', 'hard_bounce', ${deliveryEventId}
      )
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("round-trips trash, honors holds, isolates mailboxes, and purges final mail-owned bytes", async () => {
    await expect(mailboxDeadline(actorA)).resolves.toEqual({
      deleted_at: new Date("2026-01-01T00:00:00.000Z"),
      trash_purge_after: new Date("2026-01-31T00:00:00.000Z"),
    });
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { deletedAt: new Date("2026-02-01T00:00:00.000Z") },
    });
    await expect(mailboxDeadline(actorA)).resolves.toEqual({
      deleted_at: new Date("2026-01-01T00:00:00.000Z"),
      trash_purge_after: new Date("2026-01-31T00:00:00.000Z"),
    });
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { deletedAt: null },
    });
    await expect(mailboxDeadline(actorA)).resolves.toEqual({
      deleted_at: null,
      trash_purge_after: null,
    });
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { archivedAt: new Date("2026-02-01T00:00:00.000Z") },
    });
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { archivedAt: null },
    });
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { snoozedUntil: new Date("2026-04-01T00:00:00.000Z") },
    });
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { snoozedUntil: null },
    });
    await expect(
      database`
        select archived_at, snoozed_until from mail_thread_state
        where org_id = ${orgId} and actor_id = ${actorA} and thread_id = ${threadId}
      `,
    ).resolves.toEqual([{ archived_at: null, snoozed_until: null }]);
    await store.updateThreadState({
      orgId,
      actorId: actorA,
      threadId,
      patch: { deletedAt: new Date("2026-01-01T00:00:00.000Z") },
    });
    await database`
      insert into mail_retention_holds (org_id, thread_id, reason, created_by_actor_id)
      values (${orgId}, ${threadId}, 'Investigation', ${actorA})
    `;

    await expect(purge()).resolves.toEqual({
      purged_mailboxes: 0,
      purged_threads: 0,
      queued_objects: 0,
    });
    await database`delete from mail_retention_holds where org_id = ${orgId} and thread_id = ${threadId}`;

    await expect(purge()).resolves.toEqual({
      purged_mailboxes: 1,
      purged_threads: 0,
      queued_objects: 0,
    });
    await expect(canSeeMessage(actorA)).resolves.toBe(false);
    await expect(canSeeMessage(actorB)).resolves.toBe(true);
    await expect(
      database`select id from objects where id in (${attachmentId}, ${sourceId})`,
    ).resolves.toHaveLength(2);

    await database`
      update mail_thread_state set deleted_at = '2026-01-01T00:00:00.000Z'
      where org_id = ${orgId} and actor_id = ${actorB} and thread_id = ${threadId}
    `;
    await expect(purge()).resolves.toEqual({
      purged_mailboxes: 1,
      purged_threads: 1,
      queued_objects: 2,
    });
    await expect(database`select id from threads where id = ${threadId}`).resolves.toEqual([]);
    await expect(
      database`select id from objects where id in (${attachmentId}, ${sourceId})`,
    ).resolves.toEqual([]);
    await expect(database`select id from objects where id = ${driveFileId}`).resolves.toHaveLength(
      1,
    );
    await expect(
      database<{ storage_key: string }[]>`
        select storage_key from drive_quarantine_deletions
        where org_id = ${orgId} order by storage_key
      `,
    ).resolves.toEqual([{ storage_key: "mail/a" }, { storage_key: "mail/source" }]);
    await expect(
      database`
        select source_event_id, source_event_purged_at is not null as source_event_purged
        from mail_suppressions where id = ${suppressionId}
      `,
    ).resolves.toEqual([{ source_event_id: null, source_event_purged: true }]);
  });

  async function mailboxDeadline(actorId: string) {
    const rows = await database<{ deleted_at: Date | null; trash_purge_after: Date | null }[]>`
      select deleted_at, trash_purge_after from mail_thread_state
      where org_id = ${orgId} and actor_id = ${actorId} and thread_id = ${threadId}
    `;
    return rows[0];
  }

  async function purge() {
    const rows = await database<
      { purged_mailboxes: number; purged_threads: number; queued_objects: number }[]
    >`select * from helix_purge_expired_mail_trash(10, ${dueBefore})`;
    return rows[0];
  }

  async function canSeeMessage(actorId: string): Promise<boolean> {
    return database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`
        select set_config('helix.org_id', ${orgId}, true),
          set_config('helix.actor_id', ${actorId}, true)
      `;
      const rows = await tx<{ visible: boolean }[]>`
        select exists(select 1 from messages where id = ${messageId}) visible
      `;
      return rows[0]?.visible ?? false;
    });
  }

  async function cleanup(): Promise<void> {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from drive_quarantine_deletions where org_id = ${orgId}`;
      await tx`delete from mail_retention_holds where org_id = ${orgId}`;
      await tx`delete from mail_suppressions where org_id = ${orgId}`;
      await tx`delete from mail_delivery_events where org_id = ${orgId}`;
      await tx`delete from mail_outbound_messages where org_id = ${orgId}`;
      await tx`delete from mail_outbound_providers where org_id = ${orgId}`;
      await tx`delete from mail_attachment_ingestions where org_id = ${orgId}`;
      await tx`delete from mail_raw_sources where org_id = ${orgId}`;
      await tx`delete from message_attachments where org_id = ${orgId}`;
      await tx`delete from mail_message_deliveries where org_id = ${orgId}`;
      await tx`delete from mail_thread_state where org_id = ${orgId}`;
      await tx`delete from messages where org_id = ${orgId}`;
      await tx`delete from objects where org_id = ${orgId}`;
      await tx`delete from threads where org_id = ${orgId}`;
      await tx`delete from organization_memberships where org_id = ${orgId}`;
      await tx`delete from actors where org_id = ${orgId}`;
      await tx`delete from orgs where id = ${orgId}`;
    });
  }
});
