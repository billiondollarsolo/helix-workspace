import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa270000-0000-4000-8000-000000000001";
const HOST = "fa270000-0000-4000-8000-000000000011";
const START = new Date("2026-09-02T12:00:00.000Z");

describe("Meet media lifecycle", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    await cleanup(sql);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-life-live', 'Meet Life')`;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values (${HOST}, ${ORG}, 'user', 'Host')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("converges duplicate, out-of-order, reconnect, crash, and empty-timeout events", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Lifecycle",
      jitsiDomain: "meet.example.test",
      status: "scheduled",
    });
    const event = (input: {
      eventId: string;
      event: "conference.started" | "conference.ended" | "participant.joined" | "participant.left";
      seconds: number;
      sessionId?: string;
    }) =>
      store.applyMediaEvent({
        ...input,
        orgId: ORG,
        roomId: room.id,
        roomName: room.roomName,
        ...(input.event.startsWith("participant.") ? { participantId: HOST } : {}),
        occurredAt: new Date(START.getTime() + input.seconds * 1_000),
      });

    await expect(event({ eventId: "start", event: "conference.started", seconds: 0 })).resolves.toMatchObject({
      status: "active",
      version: 1,
      duplicate: false,
    });
    await expect(event({ eventId: "start", event: "conference.started", seconds: 0 })).resolves.toMatchObject({
      version: 1,
      duplicate: true,
    });
    await event({ eventId: "join-a", event: "participant.joined", sessionId: "a", seconds: 10 });
    await expect(
      event({ eventId: "leave-a", event: "participant.left", sessionId: "a", seconds: 20 }),
    ).resolves.toMatchObject({ activeParticipantCount: 0, participantDurationSeconds: 10 });
    await expect(
      event({ eventId: "late-join-a", event: "participant.joined", sessionId: "a", seconds: 15 }),
    ).resolves.toMatchObject({ activeParticipantCount: 0 });
    await expect(
      event({ eventId: "rejoin-b", event: "participant.joined", sessionId: "b", seconds: 30 }),
    ).resolves.toMatchObject({ activeParticipantCount: 1, reconnected: true });
    await expect(
      event({ eventId: "bridge-lost-b", event: "participant.left", sessionId: "b", seconds: 40 }),
    ).resolves.toMatchObject({
      activeParticipantCount: 0,
      participantDurationSeconds: 10,
      version: 6,
    });

    await expect(
      store.expireEmptyRooms({
        emptyBefore: new Date(START.getTime() + 161_000),
        limit: 10,
      }),
    ).resolves.toBe(1);
    await expect(store.getRoomById({ orgId: ORG, roomId: room.id })).resolves.toMatchObject({
      status: "ended",
      endedAt: new Date(START.getTime() + 40_000),
    });
    await expect(event({ eventId: "stale-rejoin", event: "participant.joined", sessionId: "c", seconds: 200 })).resolves.toMatchObject({
      status: "ended",
      version: 7,
      activeParticipantCount: 0,
    });
  });

  it("refuses to run the cross-tenant reconciler inside a tenant request", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${ORG}, true)`;
        return tx`select helix_expire_empty_meet_rooms(now(), 10)`;
      }),
    ).rejects.toThrow("requires an unscoped worker context");
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from meet_media_events where org_id = ${ORG}`;
  await sql`delete from meet_participant_sessions where org_id = ${ORG}`;
  await sql`delete from activity where org_id = ${ORG}`;
  await sql`delete from permissions where org_id = ${ORG}`;
  await sql`delete from meet_rooms where org_id = ${ORG}`;
  await sql`delete from threads where org_id = ${ORG}`;
  await sql`delete from actors where org_id = ${ORG}`;
  await sql`delete from orgs where id = ${ORG}`;
}
