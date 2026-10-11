import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresMailStore } from "./store.js";
import type { MailMessageInput } from "./types.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip = skipUnlessLiveDatabase("Mail labels, folders and search through the runtime role");

describe.skipIf(skip)("Mail labels, scheduled sends, participants and search", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const store = new PostgresMailStore(app);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const outsider = randomUUID();
  const aliceAddress = `${alice}@example.test`;
  let conversation = "";
  let newsletter = "";

  beforeAll(async () => {
    if (adminUrl === undefined || appUrl === undefined)
      throw new Error("Mail view tests require migration and app database URLs.");
    await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, ${orgId}, 'Mail views'), (${otherOrgId}, ${otherOrgId}, 'Other tenant')`;
    for (const [actorId, tenantId, name] of [
      [alice, orgId, "Alice"],
      [bob, orgId, "Bob"],
      [outsider, otherOrgId, "Outsider"],
    ] as const) {
      await admin`insert into actors (id, org_id, type, email, display_name)
        values (${actorId}, ${tenantId}, 'user', ${`${actorId}@example.test`}, ${name})`;
    }
    const first = await receive({
      messageId: "<plan@example.test>",
      from: { address: "samara@partner.test", name: "Samara Lee" },
      subject: "Launch plan review",
      bodyText: "Can we review the launch plan on Thursday?",
      receivedAt: new Date(Date.now() - 3 * 86_400_000),
    });
    conversation = first.threadId;
    await as(alice, () =>
      store.createOutbound({
        orgId,
        actorId: alice,
        threadId: conversation,
        envelope: {
          from: { address: aliceAddress, name: "Alice" },
          to: [{ address: "samara@partner.test" }],
          cc: [],
          bcc: [{ address: "audit@example.test" }],
          subject: "Re: Launch plan review",
          text: "Thursday works for me.",
          attachments: [],
          inReplyTo: "<plan@example.test>",
        },
        undoUntil: new Date(Date.now() - 1_000),
        outboxSubject: "mail.send",
      }),
    );
    await receive({
      messageId: "<plan-2@example.test>",
      from: { address: "samara@partner.test", name: "Samara Lee" },
      subject: "Re: Launch plan review",
      bodyText: "Great, see you then.",
      inReplyTo: "<plan@example.test>",
      references: ["<plan@example.test>"],
    });
    newsletter = (
      await receive({
        messageId: "<digest@example.test>",
        from: { address: "news@digest.test", name: "Digest" },
        subject: "Weekly digest",
        bodyText: "Top stories this week",
      })
    ).threadId;
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  function as<T>(actorId: string, callback: () => Promise<T>, tenantId = orgId): Promise<T> {
    return withTenantPostgresContext(app, { orgId: tenantId, actorId }, callback);
  }

  function receive(input: Partial<MailMessageInput> & Pick<MailMessageInput, "messageId">) {
    return withTenantPostgresContext(app, { orgId }, () =>
      store.insertInboundMessage({
        orgId,
        mailboxActorIds: [alice],
        providerDeliveryId: input.messageId,
        from: { address: "sender@example.test" },
        to: [{ address: aliceAddress }],
        subject: "Mail views",
        bodyText: "Body",
        ...input,
      }),
    );
  }

  it("projects participants as senders with 'me' and the visible message count", async () => {
    const inbox = await as(alice, () => store.listThreads({ orgId, actorId: alice }));
    const row = inbox.threads.find((thread) => thread.threadId === conversation);
    expect(row).toMatchObject({
      messageCount: 3,
      participants: [
        { name: "Samara Lee", email: "samara@partner.test", isMe: false },
        { name: "me", email: aliceAddress, isMe: true },
      ],
    });
  });

  it("creates, nests, renames, recolours and deletes personal labels with unread counts", async () => {
    await as(alice, async () => {
      const projects = await store.createLabel({
        orgId,
        actorId: alice,
        name: "Projects",
        color: "blue",
        parentId: null,
      });
      const launch = await store.createLabel({
        orgId,
        actorId: alice,
        name: "Launch",
        color: "orange",
        parentId: projects.id,
      });
      expect(projects).toMatchObject({ slug: "projects", color: "#1762b6", parentId: null });
      expect(launch).toMatchObject({ slug: "launch", parentId: projects.id });
      await expect(
        store.createLabel({
          orgId,
          actorId: alice,
          name: "projects",
          color: "red",
          parentId: null,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        store.updateLabel({ orgId, actorId: alice, id: projects.id, parentId: launch.id }),
      ).rejects.toMatchObject({ statusCode: 409 });

      await store.updateThreadState({
        orgId,
        actorId: alice,
        threadId: conversation,
        patch: { addLabels: [launch.slug] },
      });
      const renamed = await store.updateLabel({
        orgId,
        actorId: alice,
        id: launch.id,
        name: "Launch 2026",
        color: "green",
      });
      expect(renamed).toMatchObject({
        slug: "launch",
        name: "Launch 2026",
        color: "#00792f",
        threadCount: 1,
        unreadCount: 1,
      });
      const filtered = await store.listThreads({
        orgId,
        actorId: alice,
        folder: "all",
        query: "label:launch-2026 is:unread",
      });
      expect(filtered.threads.map((thread) => thread.threadId)).toEqual([conversation]);

      expect(await store.deleteLabel({ orgId, actorId: alice, id: projects.id })).toEqual(
        expect.arrayContaining([projects.id, launch.id]),
      );
      expect(await store.listLabels({ orgId, actorId: alice })).toEqual([]);
      const thread = await store.getThread({ orgId, actorId: alice, threadId: conversation });
      expect(thread?.labels).toEqual([]);
    });
    await as(bob, async () => {
      expect(await store.listLabels({ orgId, actorId: bob })).toEqual([]);
    });
  });

  it("lists, reschedules and cancels scheduled sends outside Drafts and Sent", async () => {
    await as(alice, async () => {
      const sendAt = new Date(Date.now() + 86_400_000);
      const outbound = await store.createOutbound({
        orgId,
        actorId: alice,
        envelope: {
          from: { address: aliceAddress },
          to: [{ address: "later@example.test", name: "Later" }],
          cc: [],
          bcc: [],
          subject: "Scheduled hello",
          text: "Sent tomorrow",
          attachments: [],
        },
        undoUntil: sendAt,
        scheduled: true,
        outboxSubject: "mail.send",
      });
      const listed = await store.listScheduledSends({
        orgId,
        actorId: alice,
        limit: 10,
        offset: 0,
      });
      expect(listed).toMatchObject({
        total: 1,
        scheduled: [
          {
            outboundId: outbound.id,
            subject: "Scheduled hello",
            to: [{ address: "later@example.test", name: "Later" }],
            sendAt,
          },
        ],
      });
      const scheduledFolder = await store.listThreads({
        orgId,
        actorId: alice,
        folder: "scheduled",
      });
      expect(scheduledFolder.threads.map((thread) => thread.threadId)).toEqual([outbound.threadId]);
      const drafts = await store.listThreads({ orgId, actorId: alice, folder: "drafts" });
      expect(drafts.threads.map((thread) => thread.threadId)).not.toContain(outbound.threadId);
      const folders = await store.listFolders({ orgId, actorId: alice });
      expect(folders.find((folder) => folder.id === "scheduled")?.total).toBe(1);

      const later = new Date(Date.now() + 2 * 86_400_000);
      expect(
        await store.rescheduleSend({
          orgId,
          actorId: alice,
          outboundId: outbound.id,
          sendAt: later,
        }),
      ).toMatchObject({ sendAt: later });
      expect(
        await store.rescheduleSend({ orgId, actorId: bob, outboundId: outbound.id, sendAt: later }),
      ).toBeNull();
      expect(await store.cancelOutbound({ orgId, actorId: alice, id: outbound.id })).toMatchObject({
        status: "cancelled",
      });
      expect(
        (await store.listScheduledSends({ orgId, actorId: alice, limit: 10, offset: 0 })).total,
      ).toBe(0);
    });
  });

  it("searches every folder with Gmail operators, honouring in: for Spam and Trash", async () => {
    await as(alice, async () => {
      await store.updateThreadState({
        orgId,
        actorId: alice,
        threadId: conversation,
        patch: { archivedAt: new Date() },
      });
      // Hits are messages; compare the distinct threads they belong to.
      const ids = async (query: string) => [
        ...new Set(
          (await store.search({ orgId, actorId: alice, query })).map((hit) => hit.threadId),
        ),
      ];
      expect(await ids('from:samara "launch plan"')).toEqual([conversation]);
      expect(await ids("from:me to:samara")).toEqual([conversation]);
      expect(await ids("to:audit@example.test")).toEqual([conversation]);
      expect(await ids("in:inbox launch")).toEqual([]);
      expect(await ids("subject:digest newer_than:1d")).toEqual([newsletter]);
      expect(await ids("older_than:2d")).toEqual([conversation]);
      expect(await ids("before:2000/01/01")).toEqual([]);

      const all = await store.listThreads({ orgId, actorId: alice, folder: "all" });
      expect(all.threads.map((thread) => thread.threadId).sort()).toEqual(
        [conversation, newsletter].sort(),
      );
      await store.updateThreadState({
        orgId,
        actorId: alice,
        threadId: newsletter,
        patch: { spamAt: new Date() },
      });
      expect(await ids("digest")).toEqual([]);
      expect(await ids("in:spam digest")).toEqual([newsletter]);
      expect(await ids("in:anywhere digest")).toEqual([newsletter]);
      const spamSearch = await store.listThreads({
        orgId,
        actorId: alice,
        folder: "inbox",
        query: "in:spam weekly",
      });
      expect(spamSearch.threads.map((thread) => thread.threadId)).toEqual([newsletter]);
    });
    await as(bob, async () => {
      expect(await store.search({ orgId, actorId: bob, query: "in:anywhere" })).toEqual([]);
    });
    await as(
      outsider,
      async () => {
        expect(
          await store.listThreads({ orgId: otherOrgId, actorId: outsider, folder: "all" }),
        ).toMatchObject({ total: 0 });
      },
      otherOrgId,
    );
  });
});
