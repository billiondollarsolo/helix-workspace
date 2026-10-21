import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { PostgresMeetLobbyStore } from "./lobby-store.js";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa500000-0000-4000-8000-000000000001";
const HOST = "fa500000-0000-4000-8000-000000000011";
const MEMBER = "fa500000-0000-4000-8000-000000000012";
const GUEST = "guest:fa500000-0000-4000-8000-000000000021";

describe("Meet lobby", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;
  let lobby: PostgresMeetLobbyStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    lobby = new PostgresMeetLobbyStore(sql);
    await cleanupTestTenants(sql, [ORG]);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-lobby-live', 'Meet Lobby')`;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values (${HOST}, ${ORG}, 'user', 'Host'), (${MEMBER}, ${ORG}, 'user', 'Member')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG]);
    await sql.end();
  });

  it("holds a guest until a host answers, and keeps a denied guest out", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Lobby",
      mediaDomain: "meet.example.test",
    });
    const enter = () =>
      lobby.enter({ orgId: ORG, roomId: room.id, participantSubject: GUEST, displayName: "Vera" });
    await expect(
      lobby.enter({ orgId: ORG, roomId: room.id, participantSubject: HOST, displayName: "Host" }),
    ).resolves.toEqual({ status: "proceed" });
    await expect(enter()).resolves.toEqual({
      status: "waiting",
      first: true,
      moderatorIds: [HOST],
    });
    await expect(enter()).resolves.toMatchObject({ status: "waiting", first: false });
    await expect(lobby.listWaiting({ orgId: ORG, roomId: room.id })).resolves.toMatchObject([
      { participantSubject: GUEST, displayName: "Vera" },
    ]);

    // Admitting goes through the host control, which lets the guest past the lobby.
    await store.applyControl({
      orgId: ORG,
      actorId: HOST,
      roomId: room.id,
      control: { action: "admit", participantSubject: GUEST, mediaParticipantId: GUEST },
    });
    const decide = (decision: "admitted" | "denied") =>
      lobby.decide({
        orgId: ORG,
        roomId: room.id,
        participantSubject: GUEST,
        actorId: HOST,
        decision,
      });
    await expect(decide("admitted")).resolves.toBe(true);
    await expect(enter()).resolves.toEqual({ status: "proceed" });
    await expect(lobby.listWaiting({ orgId: ORG, roomId: room.id })).resolves.toEqual([]);

    // Removed from the call, the guest waits again; a denial then sticks.
    await store.applyControl({
      orgId: ORG,
      actorId: HOST,
      roomId: room.id,
      control: {
        action: "remove",
        participantSubject: GUEST,
        mediaParticipantId: GUEST,
        ban: false,
      },
    });
    await expect(enter()).resolves.toMatchObject({ status: "waiting", first: true });
    await expect(decide("denied")).resolves.toBe(true);
    await expect(decide("denied")).resolves.toBe(false);
    await expect(enter()).resolves.toEqual({ status: "denied" });
  });

  it("lets only hosts and co-hosts allow or block guests", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Guests",
      mediaDomain: "meet.example.test",
      participantActorIds: [MEMBER],
    });
    const policy = async () =>
      (
        await sql<
          { guest_policy: string }[]
        >`select guest_policy from meet_rooms where id = ${room.id}`
      )[0]?.guest_policy;
    await expect(
      lobby.setGuestsAllowed({ orgId: ORG, roomId: room.id, actorId: MEMBER, allowed: true }),
    ).resolves.toBe(false);
    await expect(
      lobby.setGuestsAllowed({ orgId: ORG, roomId: room.id, actorId: HOST, allowed: true }),
    ).resolves.toBe(true);
    await expect(policy()).resolves.toBe("invite");
    await lobby.setGuestsAllowed({ orgId: ORG, roomId: room.id, actorId: HOST, allowed: false });
    await expect(policy()).resolves.toBe("disabled");
  });
});
