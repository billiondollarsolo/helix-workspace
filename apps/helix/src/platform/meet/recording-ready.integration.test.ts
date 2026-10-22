import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import type { OutboundMailTransport } from "../mail/outbound.js";
import type { MailOutboundEnvelope } from "../mail/types.js";
import { createMeetRecordingReadyHandler } from "./recording-ready.js";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa600000-0000-4000-8000-000000000001";
const HOST = "fa600000-0000-4000-8000-000000000011";
const COHOST = "fa600000-0000-4000-8000-000000000012";
const ATTENDEE = "fa600000-0000-4000-8000-000000000013";

describe("Meet recording ready", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    await cleanupTestTenants(sql, [ORG]);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-rec-ready', 'Meet Rec')`;
    await sql`
      insert into actors (id, org_id, type, display_name, email)
      values
        (${HOST}, ${ORG}, 'user', 'Hana Host', 'hana@example.test'),
        (${COHOST}, ${ORG}, 'user', 'Cole Cohost', 'cole@example.test'),
        (${ATTENDEE}, ${ORG}, 'user', 'Ada Attendee', 'ada@example.test')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG]);
    await sql.end();
  });

  it("names the recording and emails the hosts and co-hosts once", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Launch review",
      mediaDomain: "meet.example.test",
      participantActorIds: [ATTENDEE],
    });
    await sql`update meet_rooms set cohost_actor_ids = ${[COHOST]} where id = ${room.id}`;
    const startedAt = new Date("2026-10-22T17:50:00.000Z");
    const endedAt = new Date("2026-10-22T18:20:00.000Z");
    const attachment = await store.attachRecording({
      orgId: ORG,
      roomId: room.id,
      storageKey: `recordings/${room.id}.mp4`,
      mimeType: "video/mp4",
      byteSize: 1024,
      sha256: "a".repeat(64),
      startedAt,
      endedAt,
    });
    if (attachment === null) throw new Error("expected the recording to attach");

    const sent: MailOutboundEnvelope[] = [];
    const transport: OutboundMailTransport = {
      send: async (envelope) => {
        sent.push(envelope);
        return { accepted: true } as never;
      },
    };
    const onSaved = createMeetRecordingReadyHandler({
      sql,
      transport,
      from: { address: "no-reply@example.test", name: "Helix" },
      publicBaseUrl: "https://workspace.example.test/",
      onError: (error) => {
        throw error;
      },
    });
    const saved = {
      orgId: ORG,
      roomId: room.id,
      objectId: attachment.objectId,
      startedAt,
      endedAt,
    };
    await onSaved(saved);
    await onSaved(saved);

    const [object] = await sql<{ name: string }[]>`
      select metadata->>'name' as name from objects where id = ${attachment.objectId}
    `;
    expect(object?.name).toBe("Launch review (2026-10-22 17:50 UTC).mp4");
    expect(sent.map((mail) => mail.to[0]?.address).sort()).toEqual([
      "cole@example.test",
      "hana@example.test",
    ]);
    expect(sent[0]).toMatchObject({
      from: { address: "no-reply@example.test" },
      subject: 'Your recording of "Launch review" is ready',
    });
    expect(sent[0]?.text).toContain("(30 minutes)");
    expect(sent[0]?.text).toContain(
      `https://workspace.example.test/drive?scope=recordings&file=${attachment.objectId}`,
    );
  });
});
