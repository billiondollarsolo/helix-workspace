import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "../drive/index.js";
import { PostgresMeetStore } from "./store.js";

const ORG = "fa300000-0000-4000-8000-000000000001";
const HOST = "fa300000-0000-4000-8000-000000000011";
const MEMBER = "fa300000-0000-4000-8000-000000000012";
const UPLOAD = "fa300000-0000-4000-8000-000000000021";

describe("Meet recording promotion", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresMeetStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresMeetStore(sql);
    await cleanup(sql);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'meet-promote-live', 'Meet Promote')`;
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

  it("cannot complete before validation and freezes promoted recording identity", async () => {
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      subject: "Promotion",
      jitsiDomain: "meet.example.test",
    });
    await expect(
      store.prepareRecordingUpload({
        id: UPLOAD,
        orgId: ORG,
        roomId: room.id,
        storageKey: `recordings/${room.id}/${UPLOAD}.webm`,
        mimeType: "video/webm",
        byteSize: 12,
        sha256: "a".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBe(true);
    await expect(store.completeRecordingUpload(UPLOAD)).resolves.toBe(false);
    await expect(
      store.markRecordingUploadReady(UPLOAD, { status: "ready", antivirus: { scanned: true } }),
    ).resolves.toBe(true);
    await expect(store.completeRecordingUpload(UPLOAD)).resolves.toBe(true);
    await expect(store.completeRecordingUpload(UPLOAD)).resolves.toBe(false);

    const attachment = await store.attachRecording({
      orgId: ORG,
      roomId: room.id,
      storageKey: `recordings/${room.id}/${UPLOAD}.webm`,
      mimeType: "video/webm",
      byteSize: 12,
      sha256: "a".repeat(64),
      metadata: { validation: { status: "ready" } },
    });
    if (attachment === null) throw new Error("Expected promoted recording attachment.");
    await expect(
      sql`update objects set sha256 = ${"b".repeat(64)} where id = ${attachment.objectId}`,
    ).rejects.toThrow("validated Meet recording content is immutable");
  });

  it("inherits live meeting access and blocks purge under hold or retention", async () => {
    const drive = new PostgresDriveStore(sql);
    const room = await store.createRoom({
      orgId: ORG,
      actorId: HOST,
      participantActorIds: [MEMBER],
      subject: "Governed",
      jitsiDomain: "meet.example.test",
      metadata: {
        classification: "restricted",
        legalHold: true,
        retentionUntil: "2099-01-01T00:00:00.000Z",
        exportAllowed: false,
      },
    });
    const attachment = await store.attachRecording({
      orgId: ORG,
      roomId: room.id,
      storageKey: `recordings/${room.id}/governed.webm`,
      mimeType: "video/webm",
      byteSize: 12,
      sha256: "c".repeat(64),
      metadata: { validation: { status: "ready" } },
    });
    if (attachment === null) throw new Error("Expected governed recording attachment.");

    await expect(
      drive.openFile({ orgId: ORG, actorId: MEMBER, objectId: attachment.objectId }),
    ).resolves.not.toBeNull();
    await sql`
      update permissions set revoked_at = now(), status = 'revoked', revocation_epoch = revocation_epoch + 1
      where org_id = ${ORG} and actor_id = ${MEMBER}
        and resource_type in ('meet_room', 'thread')
        and resource_id in (${room.id}, ${room.threadId})
    `;
    await expect(
      drive.openFile({ orgId: ORG, actorId: MEMBER, objectId: attachment.objectId }),
    ).rejects.toThrow("Unknown or inaccessible Drive object");
    await sql`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${ORG}, ${MEMBER}, 'object', ${attachment.objectId}, 'reader', ${HOST})
    `;
    await expect(
      drive.openFile({ orgId: ORG, actorId: MEMBER, objectId: attachment.objectId }),
    ).resolves.not.toBeNull();
    await expect(
      drive.canExportFile({ orgId: ORG, actorId: MEMBER, objectId: attachment.objectId }),
    ).resolves.toBe(false);
    await expect(
      drive.delete({ orgId: ORG, actorId: HOST, objectId: attachment.objectId }),
    ).rejects.toThrow("protected by retention or legal hold");
    const governance = await sql<
      {
        readonly classification: string;
        readonly region: string;
        readonly export_allowed: boolean;
      }[]
    >`
      update meet_recording_governance set legal_hold = false, retention_until = now() - interval '1 day'
      where org_id = ${ORG} and object_id = ${attachment.objectId}
      returning classification, region, export_allowed
    `;
    expect(governance[0]).toMatchObject({
      classification: "restricted",
      region: "default",
      export_allowed: false,
    });
    await expect(
      drive.delete({ orgId: ORG, actorId: HOST, objectId: attachment.objectId }),
    ).resolves.toBe(true);
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from notifications where org_id = ${ORG}`;
  await sql`delete from activity where org_id = ${ORG}`;
  await sql`delete from permissions where org_id = ${ORG}`;
  await sql`delete from message_attachments where org_id = ${ORG}`;
  await sql`delete from messages where org_id = ${ORG}`;
  await sql`delete from meet_recording_uploads where org_id = ${ORG}`;
  await sql`delete from meet_rooms where org_id = ${ORG}`;
  await sql`delete from threads where org_id = ${ORG}`;
  await sql`delete from objects where org_id = ${ORG}`;
  await sql`delete from actors where org_id = ${ORG}`;
  await sql`delete from orgs where id = ${ORG}`;
}
