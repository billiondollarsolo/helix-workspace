import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { MailThreadNotFoundError } from "./errors.js";
import { PostgresMailStore } from "./store.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const enabled = adminUrl !== undefined && appUrl !== undefined;

const orgId = "a1080000-0000-4000-8000-000000000001";
const aliceId = "a1080000-0000-4000-8000-000000000011";
const bobId = "a1080000-0000-4000-8000-000000000012";
const delegateId = "a1080000-0000-4000-8000-000000000013";
const aliceThreadId = "a1080000-0000-4000-8000-000000000021";
const bobThreadId = "a1080000-0000-4000-8000-000000000022";
const aliceMessageId = "a1080000-0000-4000-8000-000000000031";
const bobMessageId = "a1080000-0000-4000-8000-000000000032";
const aliceObjectId = "a1080000-0000-4000-8000-000000000041";
const bobObjectId = "a1080000-0000-4000-8000-000000000042";

describe("mailbox actor RLS", { skip: !enabled }, () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;
  let store: PostgresMailStore;

  beforeAll(async () => {
    if (!enabled) throw new Error("Mailbox RLS database URLs are required.");
    admin = postgres(adminUrl, { max: 1, prepare: false });
    app = tenantAwarePostgresSql(postgres(appUrl, { max: 1, prepare: false }));
    store = new PostgresMailStore(app);
    await cleanup();
    await admin`
      insert into orgs (id, slug, display_name, status)
      values (${orgId}, 'mailbox-rls', 'Mailbox RLS', 'active')
    `;
    await admin`
      insert into actors (id, org_id, type, email, display_name)
      values
        (${aliceId}, ${orgId}, 'user', 'alice@mailbox.test', 'Alice'),
        (${bobId}, ${orgId}, 'user', 'bob@mailbox.test', 'Bob'),
        (${delegateId}, ${orgId}, 'user', 'delegate@mailbox.test', 'Delegate')
    `;
    await admin`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values
        (${aliceThreadId}, ${orgId}, 'mail', 'Alice private', ${aliceId}),
        (${bobThreadId}, ${orgId}, 'mail', 'Bob private', ${bobId})
    `;
    await admin`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, metadata)
      values
        (
          ${aliceMessageId}, ${orgId}, ${aliceThreadId}, null, 'mail', 'alice-search-token',
          ${admin.json({
            direction: "inbound",
            from: { address: "sender@example.test" },
            to: [{ address: "alice@mailbox.test" }],
            cc: [],
            bcc: [],
            subject: "Alice private",
          })}
        ),
        (
          ${bobMessageId}, ${orgId}, ${bobThreadId}, null, 'mail', 'bob-search-token',
          ${admin.json({
            direction: "inbound",
            from: { address: "sender@example.test" },
            to: [{ address: "bob@mailbox.test" }],
            cc: [],
            bcc: [],
            subject: "Bob private",
          })}
        )
    `;
    await admin`
      insert into mail_message_deliveries (org_id, message_id, actor_id)
      values
        (${orgId}, ${aliceMessageId}, ${aliceId}),
        (${orgId}, ${bobMessageId}, ${bobId})
    `;
    await admin`
      insert into mail_thread_state (org_id, actor_id, thread_id, category)
      values
        (${orgId}, ${aliceId}, ${aliceThreadId}, 'primary'),
        (${orgId}, ${bobId}, ${bobThreadId}, 'primary')
    `;
    await admin`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
      )
      values
        (${aliceObjectId}, ${orgId}, null, 'mail_attachment', 'mail/alice', 'text/plain', 5, ${"a".repeat(64)}, '{"status":"ready","scanStatus":"clean","dlpVerdict":"clean"}'),
        (${bobObjectId}, ${orgId}, null, 'mail_attachment', 'mail/bob', 'text/plain', 3, ${"b".repeat(64)}, '{"status":"ready","scanStatus":"clean","dlpVerdict":"clean"}')
    `;
    await admin`
      insert into mail_attachment_ingestions (
        org_id, owner_actor_id, object_id, status, storage_key, declared_mime_type,
        expected_byte_size, actual_byte_size, expected_sha256, actual_sha256, scan_evidence, expires_at
      ) values
        (${orgId}, ${aliceId}, ${aliceObjectId}, 'clean', 'mail/alice', 'text/plain',
          5, 5, ${"a".repeat(64)}, ${"a".repeat(64)}, '{"scanned":true}', now() + interval '1 hour'),
        (${orgId}, ${bobId}, ${bobObjectId}, 'clean', 'mail/bob', 'text/plain',
          3, 3, ${"b".repeat(64)}, ${"b".repeat(64)}, '{"scanned":true}', now() + interval '1 hour')
    `;
    await admin`
      insert into message_attachments (org_id, message_id, object_id, disposition, snapshot)
      values
        (${orgId}, ${aliceMessageId}, ${aliceObjectId}, 'attachment', '{}'::jsonb),
        (${orgId}, ${bobMessageId}, ${bobObjectId}, 'attachment', '{}'::jsonb)
    `;
    await admin`
      insert into mail_message_identities (message_id, org_id, normalized_message_id)
      values
        (${aliceMessageId}, ${orgId}, '<alice@mailbox.test>'),
        (${bobMessageId}, ${orgId}, '<bob@mailbox.test>')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([admin.end(), app.end()]);
  });

  it("conceals Bob from Alice across list, search, mutation, and known UUID reads", async () => {
    await withTenantPostgresContext(app, { orgId, actorId: aliceId }, async (tx) => {
      const listed = await store.listThreads({ orgId, actorId: aliceId });
      expect(listed.threads.map((thread) => thread.threadId)).toEqual([aliceThreadId]);
      await expect(
        store.search({ orgId, actorId: aliceId, query: "bob-search-token" }),
      ).resolves.toEqual([]);
      await expect(
        store.getThread({ orgId, actorId: aliceId, threadId: bobThreadId }),
      ).resolves.toBeNull();

      const knownRows = await tx<{ readonly id: string }[]>`
        select id from messages where id = ${bobMessageId}
      `;
      expect(knownRows).toEqual([]);
      const attachments = await tx<{ readonly object_id: string }[]>`
        select object_id from message_attachments where object_id = ${bobObjectId}
      `;
      expect(attachments).toEqual([]);
      const objects = await tx<{ readonly id: string }[]>`
        select id from objects where id = ${bobObjectId}
      `;
      expect(objects).toEqual([]);
      const mutations = await tx<{ readonly actor_id: string }[]>`
        update mail_thread_state set starred = true
        where org_id = ${orgId} and actor_id = ${bobId} and thread_id = ${bobThreadId}
        returning actor_id
      `;
      expect(mutations).toEqual([]);
    });
    await expect(
      withTenantPostgresContext(
        app,
        { orgId, actorId: aliceId },
        (tx) => tx`
        insert into mail_message_deliveries (org_id, message_id, actor_id)
        values (${orgId}, ${bobMessageId}, ${aliceId})
      `,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantPostgresContext(
        app,
        { orgId, actorId: aliceId },
        (tx) => tx`
        insert into mail_thread_state (org_id, actor_id, thread_id)
        values (${orgId}, ${aliceId}, ${bobThreadId})
      `,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenantPostgresContext(
        app,
        { orgId, actorId: aliceId },
        (tx) => tx`
        update messages set body = 'rewritten' where id = ${aliceMessageId}
      `,
      ),
    ).rejects.toThrow("canonical mail content is immutable");
  });

  it("rejects a reply to another owner's known thread before creating mail", async () => {
    await expect(
      withTenantPostgresContext(app, { orgId, actorId: aliceId }, () =>
        store.createOutbound({
          orgId,
          actorId: aliceId,
          threadId: bobThreadId,
          envelope: {
            from: { address: "alice@mailbox.test" },
            to: [{ address: "recipient@example.test" }],
            cc: [],
            bcc: [],
            attachments: [],
            subject: "Unauthorized reply",
            text: "Body",
          },
          undoUntil: new Date(),
          outboxSubject: "mail.send",
        }),
      ),
    ).rejects.toBeInstanceOf(MailThreadNotFoundError);
    const rows = await admin`select id from messages where thread_id = ${bobThreadId}`;
    expect(rows.map((row) => row.id)).toEqual([bobMessageId]);
  });

  it("lets an owner grant and revoke complete manager access for a delegate", async () => {
    await withTenantPostgresContext(app, { orgId, actorId: bobId }, async () => {
      const grant = await store.grantMailboxDelegate({
        orgId,
        ownerActorId: bobId,
        delegateActorId: delegateId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(grant.actorId).toBe(delegateId);
      expect(await store.listMailboxDelegates(orgId, bobId)).toHaveLength(1);
    });

    await withTenantPostgresContext(app, { orgId, actorId: delegateId }, async (tx) => {
      const listed = await store.listThreads({ orgId, actorId: bobId });
      expect(listed.threads.map((thread) => thread.threadId)).toEqual([bobThreadId]);
      expect(await store.search({ orgId, actorId: bobId, query: "bob-search-token" })).toHaveLength(
        1,
      );
      expect((await store.getThread({ orgId, actorId: bobId, threadId: bobThreadId }))?.id).toBe(
        bobThreadId,
      );
      await store.updateThreadState({
        orgId,
        actorId: bobId,
        threadId: bobThreadId,
        patch: { starred: true },
      });
      const state = await tx<{ readonly starred: boolean }[]>`
        select starred from mail_thread_state
        where org_id = ${orgId} and actor_id = ${bobId} and thread_id = ${bobThreadId}
      `;
      expect(state).toEqual([{ starred: true }]);
    });
    await withTenantPostgresContext(app, { orgId, actorId: bobId }, async () => {
      await expect(
        store.revokeMailboxDelegate({ orgId, ownerActorId: bobId, delegateActorId: delegateId }),
      ).resolves.toBe(true);
    });
    await withTenantPostgresContext(app, { orgId, actorId: delegateId }, async () => {
      expect(await store.getThread({ orgId, actorId: bobId, threadId: bobThreadId })).toBeNull();
    });
  });

  it("prevents a mailbox grantee from forging their own delegation", async () => {
    await expect(
      withTenantPostgresContext(
        app,
        { orgId, actorId: aliceId },
        (tx) => tx`
        insert into permissions (
          org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
        )
        values (${orgId}, ${aliceId}, 'mailbox', ${bobId}, 'manager', ${bobId})
      `,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  async function cleanup(): Promise<void> {
    await cleanupTestTenants(admin, [orgId]);
  }
});
