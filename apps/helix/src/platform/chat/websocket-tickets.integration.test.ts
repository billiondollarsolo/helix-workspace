import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_WEBSOCKET_AUDIENCE,
  CHAT_WEBSOCKET_PATH,
  PostgresChatWebSocketTicketStore,
} from "./websocket-tickets.js";

const orgId = "f8800000-0000-4000-8000-000000000001";
const actor: Actor = {
  id: "f8800000-0000-4000-8000-000000000011",
  orgId,
  type: "user",
  displayName: "Ticket User",
  email: "ticket@example.com",
  scopes: ["chat:read"],
};
const roomId = "f8800000-0000-4000-8000-000000000021";

describe("PostgresChatWebSocketTicketStore", { skip: !process.env.DATABASE_URL }, () => {
  let sql: postgres.Sql;
  let store: PostgresChatWebSocketTicketStore;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(databaseUrl, { max: 4, prepare: false });
    store = new PostgresChatWebSocketTicketStore(sql);
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values (${orgId}, 'chat-websocket-tickets', 'Chat Tickets')
    `;
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes)
      values (${actor.id}, ${orgId}, 'user', ${actor.email ?? null}, ${actor.displayName ?? ""}, ${sql.array([...(actor.scopes ?? [])], 1009)})
    `;
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${roomId}, ${orgId}, 'chat_room', 'Tickets', ${actor.id})
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("allows exactly one concurrent redemption and never stores the raw ticket", async () => {
    const issued = await store.issue({
      actor,
      roomId,
      audience: CHAT_WEBSOCKET_AUDIENCE,
      path: CHAT_WEBSOCKET_PATH,
    });
    await expect(
      store.consume({
        orgId: actor.orgId,
        ticket: issued.ticket,
        audience: CHAT_WEBSOCKET_AUDIENCE,
        path: "/ws/other",
      }),
    ).resolves.toBeNull();
    await expect(
      store.consume({
        orgId: actor.orgId,
        ticket: issued.ticket,
        audience: "other.websocket",
        path: CHAT_WEBSOCKET_PATH,
      }),
    ).resolves.toBeNull();

    const results = await Promise.all([
      store.consume({
        orgId: actor.orgId,
        ticket: issued.ticket,
        audience: CHAT_WEBSOCKET_AUDIENCE,
        path: CHAT_WEBSOCKET_PATH,
      }),
      store.consume({
        orgId: actor.orgId,
        ticket: issued.ticket,
        audience: CHAT_WEBSOCKET_AUDIENCE,
        path: CHAT_WEBSOCKET_PATH,
      }),
    ]);
    expect(results.filter((result) => result !== null)).toEqual([{ actor, roomId }]);
    const rows = await sql<{ readonly token_hash: string }[]>`
      select token_hash from chat_websocket_tickets where actor_id = ${actor.id}
    `;
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0]?.token_hash).not.toBe(issued.ticket);
  });

  it("rejects an expired ticket", async () => {
    const issuedAt = new Date("2026-09-02T12:00:00.000Z");
    const issued = await store.issue({
      actor,
      roomId,
      audience: CHAT_WEBSOCKET_AUDIENCE,
      path: CHAT_WEBSOCKET_PATH,
      now: issuedAt,
    });
    await expect(
      store.consume({
        orgId: actor.orgId,
        ticket: issued.ticket,
        audience: CHAT_WEBSOCKET_AUDIENCE,
        path: CHAT_WEBSOCKET_PATH,
        now: new Date(issuedAt.getTime() + 30_001),
      }),
    ).resolves.toBeNull();
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from chat_websocket_tickets where actor_id = ${actor.id}`;
  await sql`delete from threads where id = ${roomId}`;
  await sql`delete from actors where id = ${actor.id}`;
  await sql`delete from orgs where id = ${orgId}`;
  await sql`delete from identity_subjects where canonical_email = ${actor.email ?? null}`;
}
