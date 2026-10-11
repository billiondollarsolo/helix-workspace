import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { createToolRegistry } from "../tool-registry.js";
import { PostgresChatInboxStore, registerChatInboxTools } from "./inbox.js";
import { PostgresChatStore } from "./store.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip = skipUnlessLiveDatabase("Chat unread counts and mentions through the runtime role");

describe.skipIf(skip)("chat Home and Mentions projections", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const inbox = new PostgresChatInboxStore(app);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const [ada, ben, cy, outsider] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [launch, quiet, secret, foreign] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const messages = {
    adaHello: randomUUID(),
    benMention: randomUUID(),
    benReply: randomUUID(),
    secretMention: randomUUID(),
    quietOld: randomUUID(),
  };

  beforeAll(async () => {
    if (adminUrl === undefined || appUrl === undefined)
      throw new Error("Chat inbox tests require migration and app database URLs.");
    await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, ${orgId}, 'Chat inbox'), (${otherOrgId}, ${otherOrgId}, 'Other')`;
    for (const [id, tenant, name] of [
      [ada, orgId, "Ada"],
      [ben, orgId, "Ben"],
      [cy, orgId, "Cy"],
      [outsider, otherOrgId, "Outsider"],
    ] as const) {
      await admin`insert into actors (id, org_id, type, display_name, email)
        values (${id}, ${tenant}, 'user', ${name}, ${`${id}@example.test`})`;
    }
    await admin`insert into threads (id, org_id, kind, subject, created_by_actor_id) values
      (${launch}, ${orgId}, 'chat_room', 'Launch', ${ada}),
      (${quiet}, ${orgId}, 'chat_room', 'Quiet', ${ada}),
      (${secret}, ${orgId}, 'chat_room', 'Secret', ${ben}),
      (${foreign}, ${otherOrgId}, 'chat_room', 'Foreign', ${outsider})`;
    await admin`insert into chat_room_settings (thread_id, org_id, name) values
      (${launch}, ${orgId}, 'launch'), (${quiet}, ${orgId}, 'quiet'),
      (${secret}, ${orgId}, 'secret'), (${foreign}, ${otherOrgId}, 'foreign')`;
    await admin`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values
        (${orgId}, ${ada}, 'thread', ${launch}, 'owner', ${ada}),
        (${orgId}, ${ben}, 'thread', ${launch}, 'member', ${ada}),
        (${orgId}, ${ada}, 'thread', ${quiet}, 'owner', ${ada}),
        (${orgId}, ${cy}, 'thread', ${quiet}, 'member', ${ada}),
        (${orgId}, ${ben}, 'thread', ${secret}, 'owner', ${ben}),
        (${otherOrgId}, ${outsider}, 'thread', ${foreign}, 'owner', ${outsider})`;
    const mention = admin.json({ mentions: [{ id: ada, displayName: "Ada" }] });
    await admin`insert into messages (id, org_id, thread_id, actor_id, kind, body, metadata, sent_at)
      values
        (${messages.quietOld}, ${orgId}, ${quiet}, ${cy}, 'chat', 'old news', '{}', '2026-10-01T09:00:00Z'),
        (${messages.adaHello}, ${orgId}, ${launch}, ${ada}, 'chat', 'hello team', '{}', '2026-10-02T09:00:00Z'),
        (${messages.benMention}, ${orgId}, ${launch}, ${ben}, 'chat', '@Ada can you review?', ${mention}, '2026-10-02T10:00:00Z'),
        (${messages.secretMention}, ${orgId}, ${secret}, ${ben}, 'chat', '@Ada private', ${mention}, '2026-10-02T11:00:00Z')`;
    await admin`insert into messages (id, org_id, thread_id, actor_id, kind, body, metadata, sent_at, parent_message_id)
      values (${messages.benReply}, ${orgId}, ${launch}, ${ben}, 'chat', 'thread reply', '{}', '2026-10-02T12:00:00Z', ${messages.benMention})`;
    await new PostgresChatStore(admin).markRead({
      orgId,
      actorId: ada,
      roomId: quiet,
      messageId: messages.quietOld,
    });
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("counts unread messages from others and mentions per member conversation", async () => {
    expect(await inbox.unread({ orgId, actorId: ada })).toEqual({
      rooms: [
        {
          roomId: launch,
          unreadCount: 2,
          mentionCount: 1,
          lastMessageAt: "2026-10-02T12:00:00.000Z",
          lastReadAt: null,
        },
        {
          roomId: quiet,
          unreadCount: 0,
          mentionCount: 0,
          lastMessageAt: "2026-10-01T09:00:00.000Z",
          lastReadAt: expect.any(String),
        },
      ],
      totalUnread: 2,
      totalMentions: 1,
    });
    expect((await inbox.unread({ orgId, actorId: cy })).rooms.map((room) => room.roomId)).toEqual([
      quiet,
    ]);
    expect(await inbox.unread({ orgId: otherOrgId, actorId: outsider })).toMatchObject({
      totalUnread: 0,
      rooms: [{ roomId: foreign }],
    });
  });

  it("lists only mentions in conversations the actor belongs to, newest first, with paging", async () => {
    const page = await inbox.mentions({ orgId, actorId: ada, limit: 10 });
    expect(page).toEqual({
      mentions: [
        expect.objectContaining({
          roomId: launch,
          roomName: "launch",
          messageId: messages.benMention,
          actorDisplayName: "Ben",
          parentMessageId: null,
          unread: true,
        }),
      ],
      nextBefore: null,
    });
    expect(
      await inbox.mentions({
        orgId,
        actorId: ada,
        limit: 10,
        before: new Date("2026-10-02T10:00:00Z"),
      }),
    ).toEqual({ mentions: [], nextBefore: null });

    const registry = createToolRegistry();
    registerChatInboxTools(registry, { store: inbox });
    const actor = { id: ada, orgId, type: "user" as const, scopes: ["chat.read"] };
    expect(await registry.invoke("chat.unread.list", {}, { actor })).toMatchObject({
      ok: true,
      output: { totalMentions: 1 },
    });
    expect(await registry.invoke("chat.mentions.list", { limit: 1 }, { actor })).toMatchObject({
      ok: true,
      output: { mentions: [{ messageId: messages.benMention }] },
    });
    expect(
      await registry.invoke("chat.unread.list", {}, { actor: { ...actor, scopes: [] } }),
    ).toMatchObject({ ok: false, statusCode: 403 });
  });
});
