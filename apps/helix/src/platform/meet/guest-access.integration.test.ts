import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetGuestInviteTokenHash, mintMeetGuestInviteToken } from "./guest-invites.js";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa250000-0000-4000-8000-000000000001";
const FOREIGN_ORG = "fa250000-0000-4000-8000-000000000002";
const HOST = "fa250000-0000-4000-8000-000000000011";
const MEMBER = "fa250000-0000-4000-8000-000000000012";
const OUTSIDER = "fa250000-0000-4000-8000-000000000013";
const DISABLED = "fa250000-0000-4000-8000-000000000014";
const FOREIGN = "fa250000-0000-4000-8000-000000000015";
const SECRET = "meet-live-guest-secret-that-is-long-enough";

describe("Meet explicit join identity", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name) values
        (${ORG}, 'meet-guest-live', 'Meet Guest Live'),
        (${FOREIGN_ORG}, 'meet-guest-foreign', 'Meet Guest Foreign')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name, disabled_at) values
        (${HOST}, ${ORG}, 'user', 'Host', null),
        (${MEMBER}, ${ORG}, 'user', 'Member', null),
        (${OUTSIDER}, ${ORG}, 'user', 'Outsider', null),
        (${DISABLED}, ${ORG}, 'user', 'Disabled', now()),
        (${FOREIGN}, ${FOREIGN_ORG}, 'user', 'Foreign', null)
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("rejects invalid participants and enforces indexed codes plus revocable guest scope", async () => {
    await expect(
      store.createRoom({
        orgId: ORG,
        actorId: HOST,
        subject: "Foreign",
        jitsiDomain: "meet.example.test",
        participantActorIds: [FOREIGN],
      }),
    ).rejects.toThrow("participants are unavailable");
    await expect(
      store.createRoom({
        orgId: ORG,
        actorId: HOST,
        subject: "Disabled",
        jitsiDomain: "meet.example.test",
        participantActorIds: [DISABLED],
      }),
    ).rejects.toThrow("participants are unavailable");

    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "External review",
      jitsiDomain: "meet.example.test",
      participantActorIds: [MEMBER],
      guestPolicy: "domain",
      guestDomains: ["example.com"],
      lobbyEnabled: true,
    });
    expect(room.joinCode).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u);
    await expect(
      store.getRoomForActorByCode({ orgId: ORG, actorId: MEMBER, code: room.joinCode }),
    ).resolves.toMatchObject({ id: room.id });
    await expect(
      store.getRoomForActorByCode({ orgId: ORG, actorId: OUTSIDER, code: room.joinCode }),
    ).resolves.toBeNull();
    await expect(
      store.getRoomForActorByCode({ orgId: ORG, actorId: MEMBER, code: "aaaa-bbbb-cccc" }),
    ).resolves.toBeNull();

    const inviteId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const token = mintMeetGuestInviteToken(SECRET, {
      inviteId,
      orgId: ORG,
      roomId: room.id,
      expiresAt,
    });
    await expect(
      store.createGuestInvite({
        id: randomUUID(),
        orgId: ORG,
        actorId: HOST,
        roomId: room.id,
        email: "blocked@other.test",
        tokenHash: "0".repeat(64),
        expiresAt,
      }),
    ).resolves.toBeNull();
    await expect(
      store.createGuestInvite({
        id: inviteId,
        orgId: ORG,
        actorId: HOST,
        roomId: room.id,
        email: "guest@example.com",
        tokenHash: meetGuestInviteTokenHash(token),
        expiresAt,
      }),
    ).resolves.toMatchObject({ id: inviteId, roomId: room.id });

    const resolution = {
      inviteId,
      orgId: ORG,
      roomId: room.id,
      email: "guest@example.com",
      tokenHash: meetGuestInviteTokenHash(token),
      now: new Date(),
    };
    await expect(store.resolveGuestInvite(resolution)).resolves.toMatchObject({
      room: { id: room.id, lobbyEnabled: true },
      invite: { email: "guest@example.com" },
    });
    await expect(
      store.resolveGuestInvite({ ...resolution, email: "attacker@example.com" }),
    ).resolves.toBeNull();
    await expect(
      store.revokeGuestInvite({ orgId: ORG, actorId: OUTSIDER, inviteId }),
    ).resolves.toBe(false);
    await expect(store.revokeGuestInvite({ orgId: ORG, actorId: HOST, inviteId })).resolves.toBe(
      true,
    );
    await expect(store.resolveGuestInvite(resolution)).resolves.toBeNull();
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from meet_guest_invites where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from activity where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from permissions where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from meet_rooms where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from threads where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from actors where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from orgs where id in (${ORG}, ${FOREIGN_ORG})`;
}
