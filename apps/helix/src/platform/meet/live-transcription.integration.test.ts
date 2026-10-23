import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { PostgresMeetStore } from "./store.js";
import { MeetTranscriptStore } from "./transcript-store.js";

const ORG = "fa700000-0000-4000-8000-000000000001";
const HOST = "fa700000-0000-4000-8000-000000000011";

describe("Meet live transcription queue", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    await cleanupTestTenants(sql, [ORG]);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-live-tx', 'Meet Live')`;
    await sql`insert into actors (id, org_id, type, display_name, email)
      values (${HOST}, ${ORG}, 'user', 'Hana Host', 'hana@example.test')`;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG]);
    await sql.end();
  });

  it("lists requested meetings without a live capture until the request is cleared", async () => {
    const room = await new PostgresMeetStore(sql).createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Standup",
      mediaDomain: "meet.example.test",
      participantActorIds: [],
    });
    const transcripts = new MeetTranscriptStore(sql);
    const queued = async () =>
      (await transcripts.requestedRooms(100)).some((entry) => entry.roomId === room.id);

    expect(await queued()).toBe(false);
    await transcripts.setRequested(ORG, room.id, HOST, true);
    expect(await queued()).toBe(true);

    const capture = await transcripts.begin(ORG, room.id, false);
    expect(capture).not.toBeNull();
    expect(await queued()).toBe(false);
    expect(await transcripts.begin(ORG, room.id, false)).toBeNull();

    if (capture !== null) await transcripts.finish(capture, "Speech provider error.");
    expect(await queued()).toBe(true);
    await transcripts.clearRequested(ORG, room.id);
    expect(await queued()).toBe(false);
    expect(await transcripts.requested(ORG, room.id)).toBe(false);
  });

  it("refuses discovery from inside a tenant context", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${ORG}, true)`;
        await tx`select * from helix_meet_transcription_requested_rooms(5)`;
      }),
    ).rejects.toThrow("restricted to the worker");
  });
});
