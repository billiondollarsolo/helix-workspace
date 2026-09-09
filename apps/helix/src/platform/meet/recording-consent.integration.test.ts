import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa330000-0000-4000-8000-000000000001";
const HOST = "fa330000-0000-4000-8000-000000000011";
const MEMBER = "fa330000-0000-4000-8000-000000000012";
const HOST_GRANT = "fa330000-0000-4000-8000-000000000021";
const MEMBER_GRANT = "fa330000-0000-4000-8000-000000000022";
const GUEST_GRANT = "fa330000-0000-4000-8000-000000000023";
const GUEST_INVITE = "fa330000-0000-4000-8000-000000000031";
const DEVICE = "fa330000-0000-4000-8000-000000000041";

describe("Meet recording consent", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    await cleanup(sql);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-consent-live', 'Meet Consent')`;
    await sql`
      insert into actors (id, org_id, type, display_name) values
        (${HOST}, ${ORG}, 'user', 'Host'),
        (${MEMBER}, ${ORG}, 'user', 'Member')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("authorizes only moderators after every active member and guest has durable consent", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Consent proof",
      jitsiDomain: "meet.example.test",
      participantActorIds: [MEMBER],
      guestPolicy: "invite",
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await expect(
      store.recordMemberRecordingConsent({
        orgId: ORG,
        roomId: room.id,
        actorId: HOST,
        joinGrantId: HOST_GRANT,
        deviceId: DEVICE,
        expiresAt,
      }),
    ).resolves.toBe(true);
    await store.applyMediaEvent({
      eventId: "member-joined",
      orgId: ORG,
      roomId: room.id,
      event: "participant.joined",
      sessionId: "member-session",
      participantId: MEMBER,
      occurredAt: new Date(),
    });
    await expect(
      store.authorizeRecordingStart({ orgId: ORG, roomId: room.id, actorId: HOST }),
    ).resolves.toBeNull();

    await expect(
      store.recordMemberRecordingConsent({
        orgId: ORG,
        roomId: room.id,
        actorId: MEMBER,
        joinGrantId: MEMBER_GRANT,
        deviceId: DEVICE,
        expiresAt,
      }),
    ).resolves.toBe(true);
    await expect(
      store.authorizeRecordingStart({ orgId: ORG, roomId: room.id, actorId: MEMBER }),
    ).resolves.toBeNull();

    await expect(
      store.createGuestInvite({
        id: GUEST_INVITE,
        orgId: ORG,
        actorId: HOST,
        roomId: room.id,
        email: "guest@example.test",
        tokenHash: "a".repeat(64),
        expiresAt,
      }),
    ).resolves.toMatchObject({ id: GUEST_INVITE });
    await expect(
      store.recordGuestRecordingConsent({
        orgId: ORG,
        roomId: room.id,
        guestInviteId: GUEST_INVITE,
        joinGrantId: GUEST_GRANT,
        deviceId: DEVICE,
        expiresAt,
      }),
    ).resolves.toBe(true);
    await store.applyMediaEvent({
      eventId: "guest-joined",
      orgId: ORG,
      roomId: room.id,
      event: "participant.joined",
      sessionId: "guest-session",
      participantId: `guest:${GUEST_INVITE}`,
      occurredAt: new Date(),
    });

    const authorization = await store.authorizeRecordingStart({
      orgId: ORG,
      roomId: room.id,
      actorId: HOST,
    });
    expect(authorization?.participantSubjects).toEqual([HOST, MEMBER, `guest:${GUEST_INVITE}`]);
    if (authorization === null) throw new Error("Expected recording authorization.");
    const startedAt = new Date(authorization.expiresAt.getTime() - 1);
    await expect(
      store.claimRecordingStartAuthorization({
        orgId: ORG,
        roomId: room.id,
        startedAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(false);
    await expect(
      store.claimRecordingStartAuthorization({
        orgId: ORG,
        roomId: room.id,
        startedAt,
      }),
    ).resolves.toBe(true);
    await store.applyMediaEvent({
      eventId: "recording-started",
      orgId: ORG,
      roomId: room.id,
      event: "recording.started",
      occurredAt: startedAt,
    });
    await expect(store.getRoomById({ orgId: ORG, roomId: room.id })).resolves.toMatchObject({
      recordingActive: true,
    });
    await expect(
      store.claimRecordingUploadAuthorization({
        orgId: ORG,
        roomId: room.id,
        startedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimRecordingUploadAuthorization({ orgId: ORG, roomId: room.id, startedAt }),
    ).resolves.toBe(false);
    await store.applyMediaEvent({
      eventId: "recording-ended",
      orgId: ORG,
      roomId: room.id,
      event: "recording.ended",
      occurredAt: new Date(startedAt.getTime() + 1_000),
    });
    await expect(store.getRoomById({ orgId: ORG, roomId: room.id })).resolves.toMatchObject({
      recordingActive: false,
    });
    const evidence = await sql<
      {
        readonly id: string;
        readonly participant_subject: string;
        readonly device_id: string;
        readonly consent_policy: string;
        readonly jurisdiction: string;
        readonly notice_version: string;
      }[]
    >`
      select id, participant_subject, device_id, consent_policy, jurisdiction, notice_version
      from meet_recording_consents
      where org_id = ${ORG}
      order by participant_subject
    `;
    expect(evidence).toHaveLength(3);
    expect(evidence.map((row) => row.id)).toEqual(
      expect.arrayContaining([HOST_GRANT, MEMBER_GRANT, GUEST_GRANT]),
    );
    expect(evidence.every((row) => row.device_id === DEVICE)).toBe(true);
    expect(evidence.map((row) => row.participant_subject)).toEqual(
      expect.arrayContaining([HOST, MEMBER, `guest:${GUEST_INVITE}`]),
    );
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consent_policy: "explicit-all-parties",
          jurisdiction: "global",
          notice_version: "2026-09-02",
        }),
      ]),
    );
    await expect(
      sql`select verb from activity where org_id = ${ORG} and verb = 'meet.recording.start.authorized'`,
    ).resolves.toHaveLength(1);
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from meet_recording_authorizations where org_id = ${ORG}`;
  await sql`delete from meet_recording_consents where org_id = ${ORG}`;
  await sql`delete from meet_media_events where org_id = ${ORG}`;
  await sql`delete from meet_participant_sessions where org_id = ${ORG}`;
  await sql`delete from meet_guest_invites where org_id = ${ORG}`;
  await sql`delete from activity where org_id = ${ORG}`;
  await sql`delete from permissions where org_id = ${ORG}`;
  await sql`delete from meet_rooms where org_id = ${ORG}`;
  await sql`delete from threads where org_id = ${ORG}`;
  await sql`delete from actors where org_id = ${ORG}`;
  await sql`delete from orgs where id = ${ORG}`;
}
