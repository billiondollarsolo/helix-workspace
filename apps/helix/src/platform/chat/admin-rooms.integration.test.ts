import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { PostgresChatAdminRoomStore } from "./admin-rooms.js";
import { PostgresChatStore } from "./store.js";

const ORG_ID = "fa150000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "fa150000-0000-4000-8000-000000000002";
const ADMIN_ID = "fa150000-0000-4000-8000-000000000011";
const PERSON_ID = "fa150000-0000-4000-8000-000000000012";
const OTHER_PERSON_ID = "fa150000-0000-4000-8000-000000000013";
const AGENT_ID = "fa150000-0000-4000-8000-000000000014";
const OTHER_AGENT_ID = "fa150000-0000-4000-8000-000000000015";
const OUTSIDER_ID = "fa150000-0000-4000-8000-000000000021";

describe("Chat rooms for administrators", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let chat: PostgresChatStore;
  let store: PostgresChatAdminRoomStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 4, prepare: false });
    chat = new PostgresChatStore(sql);
    store = new PostgresChatAdminRoomStore(sql);
    await cleanupTestTenants(sql, [ORG_ID, OTHER_ORG_ID]);
    await sql`
      insert into orgs (id, slug, display_name)
      values
        (${ORG_ID}, 'chat-admin-rooms-proof', 'Chat Admin Rooms Proof'),
        (${OTHER_ORG_ID}, 'chat-admin-rooms-other', 'Chat Admin Rooms Other')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values
        (${ADMIN_ID}, ${ORG_ID}, 'user', 'Admin'),
        (${PERSON_ID}, ${ORG_ID}, 'user', 'Avery'),
        (${OTHER_PERSON_ID}, ${ORG_ID}, 'user', 'Blake'),
        (${AGENT_ID}, ${ORG_ID}, 'agent', 'Triage agent'),
        (${OTHER_AGENT_ID}, ${ORG_ID}, 'agent', 'Research agent'),
        (${OUTSIDER_ID}, ${OTHER_ORG_ID}, 'user', 'Outsider')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG_ID, OTHER_ORG_ID]);
    await sql.end();
  });

  it("hides private rooms and direct messages until allowed, and agent-only rooms until asked", async () => {
    const open = await chat.createRoom({
      orgId: ORG_ID,
      actorId: PERSON_ID,
      subject: "Announcements",
      privacy: "discoverable",
    });
    const secret = await chat.createRoom({
      orgId: ORG_ID,
      actorId: PERSON_ID,
      subject: "Reorg planning",
      privacy: "private",
      memberActorIds: [OTHER_PERSON_ID, AGENT_ID],
    });
    const direct = await chat.createRoom({
      orgId: ORG_ID,
      actorId: PERSON_ID,
      kind: "chat_dm",
      memberActorIds: [OTHER_PERSON_ID],
    });
    const agents = await chat.createRoom({
      orgId: ORG_ID,
      actorId: AGENT_ID,
      subject: "Agent handoff",
      privacy: "private",
      memberActorIds: [OTHER_AGENT_ID],
    });
    const elsewhere = await chat.createRoom({
      orgId: OTHER_ORG_ID,
      actorId: OUTSIDER_ID,
      subject: "Another organization",
      privacy: "discoverable",
    });

    const list = async (includePrivate: boolean, includeAgentOnly: boolean) => {
      const listed = await store.list({
        orgId: ORG_ID,
        actorId: ADMIN_ID,
        includePrivate,
        includeAgentOnly,
      });
      return { ...listed, ids: listed.rooms.map((room) => room.id).sort() };
    };

    const byDefault = await list(false, false);
    expect(byDefault.ids).toEqual([open.id]);
    expect(byDefault.hiddenPrivateCount).toBe(2);
    expect(byDefault.rooms[0]).toMatchObject({
      name: "Announcements",
      kind: "chat_room",
      privacy: "discoverable",
      memberCount: 1,
      agentOnly: false,
    });

    const withAgents = await list(false, true);
    expect(withAgents.ids).toEqual([open.id, agents.id].sort());
    expect(withAgents.hiddenPrivateCount).toBe(2);
    expect(withAgents.rooms.find((room) => room.id === agents.id)).toMatchObject({
      name: "Agent handoff",
      privacy: "private",
      memberCount: 2,
      agentOnly: true,
    });

    const withPrivate = await list(true, false);
    expect(withPrivate.ids).toEqual([open.id, secret.id, direct.id].sort());
    expect(withPrivate.hiddenPrivateCount).toBe(0);
    expect(withPrivate.rooms.find((room) => room.id === direct.id)).toMatchObject({
      kind: "chat_dm",
      name: "Avery, Blake",
      memberCount: 2,
    });

    expect((await list(true, true)).ids).not.toContain(elsewhere.id);

    await expect(
      store.list({
        orgId: ORG_ID,
        actorId: ADMIN_ID,
        includePrivate: false,
        includeAgentOnly: false,
        query: "no such room",
      }),
    ).resolves.toEqual({ rooms: [], hiddenPrivateCount: 2 });
    await expect(
      store.list({
        orgId: ORG_ID,
        actorId: OUTSIDER_ID,
        includePrivate: true,
        includeAgentOnly: true,
      }),
    ).rejects.toThrow();
  });
});
