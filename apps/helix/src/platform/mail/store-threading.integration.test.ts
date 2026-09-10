import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { MailThreadNotFoundError } from "./errors.js";
import { PostgresMailStore } from "./store.js";
import type { MailMessageInput } from "./types.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip = skipUnlessLiveDatabase("Mail threading through the runtime database role");

describe.skipIf(skip)("Mail threading through the public store facade", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const store = new PostgresMailStore(app);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const outsider = randomUUID();

  beforeAll(async () => {
    if (adminUrl === undefined || appUrl === undefined)
      throw new Error("Mail threading tests require migration and app database URLs.");
    await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, ${orgId}, 'Threading test'), (${otherOrgId}, ${otherOrgId}, 'Other tenant')`;
    for (const [actorId, tenantId] of [
      [alice, orgId],
      [bob, orgId],
      [outsider, otherOrgId],
    ] as const) {
      await admin`insert into actors (id, org_id, type, email, display_name)
        values (${actorId}, ${tenantId}, 'user', ${`${actorId}@example.test`}, 'Mailbox owner')`;
    }
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  function receive(input: Partial<MailMessageInput> & Pick<MailMessageInput, "messageId">) {
    const tenantId = input.orgId ?? orgId;
    return withTenantPostgresContext(app, { orgId: tenantId }, () =>
      store.insertInboundMessage({
        orgId: tenantId,
        mailboxActorIds: [alice],
        providerDeliveryId: input.messageId,
        from: { address: "sender@example.test" },
        to: [{ address: "recipient@example.test" }],
        subject: "Threading",
        bodyText: "Message body",
        ...input,
      }),
    );
  }

  it("selects the nearest reference shared by every recipient within the tenant", async () => {
    const shared = await receive({
      messageId: "<shared@example.test>",
      mailboxActorIds: [alice, bob],
    });
    const privateParent = await receive({ messageId: "<private@example.test>" });
    const foreign = await receive({
      orgId: otherOrgId,
      messageId: "<foreign@example.test>",
      mailboxActorIds: [outsider],
    });
    const reply = await receive({
      messageId: "<reply@example.test>",
      mailboxActorIds: [alice, bob],
      inReplyTo: "<foreign@example.test>",
      references: ["<shared@example.test>", "<private@example.test>"],
    });
    expect(reply.threadId).toBe(shared.threadId);
    expect(reply.threadId).not.toBe(privateParent.threadId);
    expect(reply.threadId).not.toBe(foreign.threadId);
    await withTenantPostgresContext(app, { orgId, actorId: bob }, async () => {
      const thread = await store.getThread({ orgId, actorId: bob, threadId: shared.threadId });
      expect(thread?.messages.map((message) => message.id)).toEqual([
        shared.messageId,
        reply.messageId,
      ]);
      expect(
        await store.getThread({ orgId, actorId: bob, threadId: privateParent.threadId }),
      ).toBeNull();
      const inbox = await store.listThreads({ orgId, actorId: bob });
      expect(inbox.threads.map((thread) => thread.threadId)).toEqual([shared.threadId]);
      expect(
        (await store.listFolders({ orgId, actorId: bob })).find((folder) => folder.id === "inbox")
          ?.total,
      ).toBe(1);
    });
  });

  it("persists one canonical message and delivers retries only to new recipients", async () => {
    const first = await receive({ messageId: "<retry@example.test>" });
    const retry = await receive({
      messageId: "<retry@example.test>",
      mailboxActorIds: [alice, bob],
    });
    const repeated = await receive({
      messageId: "<retry@example.test>",
      mailboxActorIds: [alice, bob],
    });
    expect(retry).toMatchObject({
      messageId: first.messageId,
      created: false,
      deliveredActorIds: [bob],
    });
    expect(repeated).toMatchObject({
      messageId: first.messageId,
      created: false,
      deliveredActorIds: [],
    });
    const deliveries =
      await admin`select actor_id from mail_message_deliveries where message_id = ${first.messageId}`;
    expect(deliveries.map((row) => row.actor_id).sort()).toEqual([alice, bob].sort());
    const events = await admin`select count(*)::int as count from outbox
      where payload->>'messageId' = ${first.messageId} and subject = 'activity.mail.received'`;
    expect(events[0]?.count).toBe(2);
    await expect(
      receive({
        messageId: "<retry@example.test>",
        providerDeliveryId: "different-provider-event",
      }),
    ).rejects.toThrow("Inbound mail identity collision");
  });

  it("rejects unknown, foreign, and non-mail explicit threads before inserting messages", async () => {
    const chatThread = randomUUID();
    const foreignThread = randomUUID();
    await admin`insert into threads (id, org_id, kind, subject) values
      (${chatThread}, ${orgId}, 'chat_room', 'Chat'), (${foreignThread}, ${otherOrgId}, 'mail', 'Foreign')`;
    for (const threadId of [randomUUID(), chatThread, foreignThread]) {
      await expect(
        receive({ messageId: `<${threadId}@example.test>`, threadId }),
      ).rejects.toBeInstanceOf(MailThreadNotFoundError);
    }
    const rows =
      await admin`select id from messages where thread_id in (${chatThread}, ${foreignThread})`;
    expect(rows).toEqual([]);
  });
});
