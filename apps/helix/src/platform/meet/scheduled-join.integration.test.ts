import type { Actor } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { createToolRegistry, type RuntimeToolRegistry } from "../tool-registry.js";
import { createMeetConferenceProvider } from "./conference.js";
import { PostgresMeetStore } from "./store.js";
import { registerMeetTools } from "./tools.js";

const ORG = "fa260000-0000-4000-8000-000000000001";
const FOREIGN_ORG = "fa260000-0000-4000-8000-000000000002";
const ORGANIZER = "fa260000-0000-4000-8000-000000000011";
const ATTENDEE = "fa260000-0000-4000-8000-000000000012";
const OUTSIDER = "fa260000-0000-4000-8000-000000000013";
const FOREIGN = "fa260000-0000-4000-8000-000000000014";

const skip = skipUnlessLiveDatabase("Meet scheduled-room join");

describe("joining Calendar conferencing rooms", { skip }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;
  let registry: RuntimeToolRegistry;
  let conference: ReturnType<typeof createMeetConferenceProvider>;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    registry = createToolRegistry();
    registerMeetTools(registry, {
      store,
      jwtSecret: "meet-scheduled-join-secret-long-enough",
      jitsiPublicUrl: "https://meet.helix.test",
    });
    conference = createMeetConferenceProvider({
      store,
      jitsiPublicUrl: "https://meet.helix.test",
      publicBaseUrl: "https://helix.test",
    });
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name) values
        (${ORG}, 'meet-scheduled-join', 'Meet Scheduled Join'),
        (${FOREIGN_ORG}, 'meet-scheduled-foreign', 'Meet Scheduled Foreign')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name) values
        (${ORGANIZER}, ${ORG}, 'user', 'Organizer'),
        (${ATTENDEE}, ${ORG}, 'user', 'Attendee'),
        (${OUTSIDER}, ${ORG}, 'user', 'Outsider'),
        (${FOREIGN}, ${FOREIGN_ORG}, 'user', 'Foreign')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  async function calendarRoom(subject: string) {
    const startsAt = new Date(Date.now() + 60 * 60_000);
    return conference.createRoom({
      orgId: ORG,
      actorId: ORGANIZER,
      subject,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      participantActorIds: [ATTENDEE],
    });
  }

  async function roomStatus(roomId: string): Promise<string | undefined> {
    const rows = await sql<{ status: string }[]>`select status from meet_rooms where id = ${roomId}`;
    return rows[0]?.status;
  }

  it("lets an invited attendee join by code, opening the scheduled room", async () => {
    const room = await calendarRoom("Planning sync");
    expect(await roomStatus(room.roomId)).toBe("scheduled");

    const outsider = await registry.invoke(
      "meet.join-by-code",
      { code: room.joinCode, ...consent() },
      { actor: actor(OUTSIDER) },
    );
    expect(outsider.ok).toBe(false);
    const foreign = await registry.invoke(
      "meet.join-by-code",
      { code: room.joinCode, ...consent() },
      { actor: actor(FOREIGN, FOREIGN_ORG) },
    );
    expect(foreign.ok).toBe(false);
    expect(await roomStatus(room.roomId)).toBe("scheduled");

    const joined = await registry.invoke<{ roomId: string; token: string }>(
      "meet.join-by-code",
      { code: room.joinCode, ...consent() },
      { actor: actor(ATTENDEE) },
    );
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.output.roomId).toBe(room.roomId);
    expect(joined.output.token.split(".")).toHaveLength(3);
    expect(await roomStatus(room.roomId)).toBe("active");

    const opened = await sql<{ actor_id: string }[]>`
      select actor_id from activity
      where org_id = ${ORG} and object_id = ${room.roomId} and verb = 'meet.room.opened'
    `;
    expect(opened).toEqual([{ actor_id: ATTENDEE }]);

    const rejoin = await registry.invoke(
      "meet.join-by-code",
      { code: room.joinCode, ...consent() },
      { actor: actor(ORGANIZER) },
    );
    expect(rejoin.ok).toBe(true);
    const openedAgain = await sql`
      select 1 from activity where object_id = ${room.roomId} and verb = 'meet.room.opened'
    `;
    expect(openedAgain).toHaveLength(1);
  });

  it("mints a join token for a scheduled room and refuses ended rooms", async () => {
    const room = await calendarRoom("Design review");
    const outsider = await registry.invoke(
      "meet.mint-token",
      { roomId: room.roomId, ...consent() },
      { actor: actor(OUTSIDER) },
    );
    expect(outsider.ok).toBe(false);
    expect(await roomStatus(room.roomId)).toBe("scheduled");

    const minted = await registry.invoke<{ roomId: string; canModerate: boolean }>(
      "meet.mint-token",
      { roomId: room.roomId, ...consent() },
      { actor: actor(ORGANIZER) },
    );
    if (!minted.ok) throw new Error(minted.error);
    expect(minted.output).toMatchObject({ roomId: room.roomId, canModerate: true });
    expect(await roomStatus(room.roomId)).toBe("active");

    await sql`update meet_rooms set status = 'ended', ended_at = now() where id = ${room.roomId}`;
    const ended = await registry.invoke(
      "meet.mint-token",
      { roomId: room.roomId, ...consent() },
      { actor: actor(ATTENDEE) },
    );
    expect(ended).toMatchObject({ ok: false });
    const endedByCode = await registry.invoke(
      "meet.join-by-code",
      { code: room.joinCode, ...consent() },
      { actor: actor(ATTENDEE) },
    );
    expect(endedByCode.ok).toBe(false);
    expect(await roomStatus(room.roomId)).toBe("ended");
  });
});

function actor(id: string, orgId = ORG): Actor {
  return { id, orgId, type: "user", displayName: id, scopes: ["meet.read", "meet.write"] };
}

function consent() {
  return {
    recordingNoticeAccepted: true,
    recordingNoticeVersion: "2026-09-02",
    deviceId: randomUUID(),
    joinGrantId: randomUUID(),
  };
}

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from activity where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from meet_recording_consents where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from permissions where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from meet_rooms where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from threads where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from actors where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from orgs where id in (${ORG}, ${FOREIGN_ORG})`;
}
