import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMailStore } from "./store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 2, prepare: false });

describe.skipIf(sql === null)("durable mail drafts", () => {
  const database = sql as postgres.Sql;
  const store = new PostgresMailStore(database);
  const orgId = "d2200000-0000-4000-8000-000000000001";
  const actorId = "d2200000-0000-4000-8000-000000000002";
  const objectId = "d2200000-0000-4000-8000-000000000003";

  beforeAll(async () => {
    await cleanup();
    await database`insert into orgs (id, slug, display_name) values (${orgId}, 'mail22', 'Mail 22')`;
    await database`
      insert into actors (id, org_id, type, email, display_name)
      values (${actorId}, ${orgId}, 'user', 'draft@mail22.test', 'Draft owner')
    `;
    await database`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
      values (${objectId}, ${orgId}, ${actorId}, 'file', 'mail22/file', 'text/plain', 5, '{"status":"ready"}')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  async function cleanup(): Promise<void> {
    await database`delete from mail_drafts where org_id = ${orgId}`;
    await database`delete from objects where org_id = ${orgId}`;
    await database`delete from resource_classifications where org_id = ${orgId}`;
    await database`delete from actors where id = ${actorId}`;
    await database`delete from orgs where id = ${orgId}`;
  }

  it("replays retries, rejects stale revisions, and preserves attachments", async () => {
    const firstInput = {
      orgId,
      actorId,
      idempotencyKey: "d2200000-0000-4000-8000-000000000004",
      attachmentObjectIds: [objectId],
      envelope: {
        to: [{ address: "to@example.test" }],
        subject: "Draft",
        bodyText: "Body",
        attachments: [{ objectId }],
      },
    } as const;
    const first = await store.saveDraft(firstInput);
    const replay = await store.saveDraft(firstInput);
    expect(replay).toMatchObject({ id: first.id, revision: 1 });

    const updated = await store.saveDraft({
      ...firstInput,
      id: first.id,
      expectedRevision: 1,
      idempotencyKey: "d2200000-0000-4000-8000-000000000005",
      envelope: { ...firstInput.envelope, bodyText: "Recovered exactly" },
    });
    expect(updated).toMatchObject({ id: first.id, revision: 2 });
    expect(updated.envelope).toMatchObject({
      bodyText: "Recovered exactly",
      attachments: [{ objectId }],
    });

    await expect(
      store.saveDraft({
        ...firstInput,
        id: first.id,
        expectedRevision: 1,
        idempotencyKey: "d2200000-0000-4000-8000-000000000006",
      }),
    ).rejects.toThrow("changed elsewhere");
    expect(await store.discardDraft({ orgId, actorId, id: first.id, expectedRevision: 1 })).toBe(
      false,
    );
    expect(await store.getDraft({ orgId, actorId, id: first.id })).toMatchObject({ revision: 2 });
  });

  it("expires drafts only from an unscoped worker context", async () => {
    await database`update mail_drafts set expires_at = now() - interval '1 second' where org_id = ${orgId}`;
    await expect(
      database.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select helix_expire_mail_drafts(10, now())`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    const result = await database<{ expired: number }[]>`
      select helix_expire_mail_drafts(10, now()) as expired
    `;
    expect(result[0]?.expired).toBe(1);
  });
});
