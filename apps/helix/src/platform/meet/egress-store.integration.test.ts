import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { PostgresMeetEgressRecordingStore } from "./egress-store.js";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa400000-0000-4000-8000-000000000001";
const HOST = "fa400000-0000-4000-8000-000000000011";
const FIRST = "fa400000-0000-4000-8000-000000000021";
const SECOND = "fa400000-0000-4000-8000-000000000022";

describe("Meet Egress recordings", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;
  let recordings: PostgresMeetEgressRecordingStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    recordings = new PostgresMeetEgressRecordingStore(sql);
    await cleanupTestTenants(sql, [ORG]);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-egress-live', 'Meet Egress')`;
    await sql`insert into actors (id, org_id, type, display_name) values (${HOST}, ${ORG}, 'user', 'Host')`;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG]);
    await sql.end();
  });

  it("allows one running recording per room and promotes it once its digest is known", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Egress",
      mediaDomain: "meet.example.test",
    });
    const prepare = (id: string) =>
      recordings.prepare({
        id,
        orgId: ORG,
        roomId: room.id,
        storageKey: `recordings/egress/${id}.mp4`,
        mimeType: "video/mp4",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    await expect(prepare(FIRST)).resolves.toBe(true);
    await expect(prepare(SECOND)).resolves.toBe(false);
    await expect(recordings.setEgressId({ orgId: ORG, id: FIRST, egressId: "EG_a" })).resolves.toBe(
      true,
    );
    await expect(recordings.setEgressId({ orgId: ORG, id: FIRST, egressId: "EG_b" })).resolves.toBe(
      false,
    );
    await expect(recordings.active({ orgId: ORG, roomId: room.id })).resolves.toMatchObject({
      id: FIRST,
      egressId: "EG_a",
    });
    await expect(recordings.byEgressId({ orgId: ORG, egressId: "EG_a" })).resolves.toMatchObject({
      id: FIRST,
      roomId: room.id,
    });

    // Without a digest the record cannot be validated.
    await expect(store.markRecordingUploadReady(FIRST, { status: "ready" })).rejects.toThrow();
    await expect(
      recordings.setDigest({ orgId: ORG, id: FIRST, byteSize: 40, sha256: "c".repeat(64) }),
    ).resolves.toBe(true);
    await expect(store.getRecordingUpload(FIRST)).resolves.toMatchObject({
      byteSize: 40,
      sha256: "c".repeat(64),
      roomId: room.id,
    });
    await expect(store.markRecordingUploadReady(FIRST, { status: "ready" })).resolves.toBe(true);
    await expect(store.completeRecordingUpload(FIRST)).resolves.toBe(true);

    // The room can record again; an abandoned recording leaves nothing behind.
    await expect(recordings.active({ orgId: ORG, roomId: room.id })).resolves.toBeNull();
    await expect(prepare(SECOND)).resolves.toBe(true);
    await recordings.abandon({ orgId: ORG, id: SECOND });
    await expect(sql`select id from meet_recording_uploads where id = ${SECOND}`).resolves.toEqual(
      [],
    );
  });

  it("still requires a digest for ordinary uploads", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Upload",
      mediaDomain: "meet.example.test",
    });
    await expect(
      sql`
        insert into meet_recording_uploads (id, org_id, room_id, storage_key, mime_type, expires_at)
        values (gen_random_uuid(), ${ORG}, ${room.id}, 'recordings/x.mp4', 'video/mp4', now())
      `,
    ).rejects.toThrow(/meet_recording_uploads_upload_digest_check/u);
  });
});
