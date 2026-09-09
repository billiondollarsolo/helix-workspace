import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.env.DATABASE_URL === undefined)("mail compliance journal lifecycle", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const org = "f1730000-0000-4000-8000-000000000001";
  const actor = "f1730000-0000-4000-8000-000000000011";
  const thread = "f1730000-0000-4000-8000-000000000021";
  const message = "f1730000-0000-4000-8000-000000000031";

  async function cleanup() {
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const table of [
        "mail_journal_entries",
        "mail_journal_settings",
        "messages",
        "threads",
        "organization_memberships",
        "actors",
      ]) {
        await tx.unsafe(`delete from ${table} where org_id = $1`, [org]);
      }
      await tx`delete from orgs where id = ${org}`;
    });
  }

  beforeAll(async () => {
    const ready = await sql<{ readonly ready: boolean }[]>`
      select to_regprocedure('helix_record_mail_journal(uuid,uuid)') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migration 0173 before this test.");
    await cleanup();
    await sql`insert into orgs(id, slug, display_name) values (${org}, 'mail-173', 'Mail Journal')`;
    await sql`insert into actors(id, org_id, type, email, display_name)
      values (${actor}, ${org}, 'user', 'owner@journal.test', 'Owner')`;
    await sql`insert into threads(id, org_id, kind, subject, created_by_actor_id)
      values (${thread}, ${org}, 'mail', 'Journal evidence', ${actor})`;
    await sql`insert into messages(id, org_id, thread_id, actor_id, kind, body, metadata)
      values (${message}, ${org}, ${thread}, ${actor}, 'mail', 'immutable body',
        ${sql.json({ direction: "inbound", from: "sender@example.test", to: ["owner@journal.test"] })})`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("captures immutable evidence, blocks source deletion, then purges expired evidence", async () => {
    const captured = await sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${actor}, true)`;
      await tx`insert into mail_journal_settings(org_id, enabled, retention_days, updated_by_actor_id)
        values (${org}, true, 7, ${actor})`;
      return tx<{ readonly captured: boolean }[]>`
        select helix_record_mail_journal(${org}, ${message}) as captured
      `;
    });
    expect(captured[0]?.captured).toBe(true);

    const entries = await sql<
      { readonly content_sha256: string; readonly body: string; readonly direction: string }[]
    >`
      select content_sha256, snapshot->'message'->>'body' as body, direction
      from mail_journal_entries where org_id = ${org} and message_id = ${message}
    `;
    expect(entries).toEqual([
      {
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        body: "immutable body",
        direction: "inbound",
      },
    ]);
    await expect(
      sql`delete from messages where org_id = ${org} and id = ${message}`,
    ).rejects.toThrow(/protected by compliance journal/u);
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${org}, true)`;
        await tx`update mail_journal_entries set snapshot = '{}' where org_id = ${org}`;
      }),
    ).rejects.toThrow(/permission denied/u);

    await sql`update mail_journal_entries set retention_until = statement_timestamp() - interval '1 second'
      where org_id = ${org} and message_id = ${message}`;
    const purged = await sql<{ readonly purged: number }[]>`
      select helix_purge_expired_mail_journal(10, statement_timestamp()) as purged
    `;
    expect(purged[0]?.purged).toBe(1);
    await expect(
      sql`delete from messages where org_id = ${org} and id = ${message}`,
    ).resolves.toHaveProperty("count", 1);
  });
});
