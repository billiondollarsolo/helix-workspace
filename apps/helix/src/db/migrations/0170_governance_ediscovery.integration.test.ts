import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.env.DATABASE_URL === undefined)(
  "governance hold and retention lifecycle",
  () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
    const org = "f1700000-0000-4000-8000-000000000001";
    const owner = "f1700000-0000-4000-8000-000000000011";
    const thread = "f1700000-0000-4000-8000-000000000021";
    const message = "f1700000-0000-4000-8000-000000000031";
    const expiredMessage = "f1700000-0000-4000-8000-000000000032";
    const matter = "f1700000-0000-4000-8000-000000000041";
    const hold = "f1700000-0000-4000-8000-000000000051";

    async function cleanup() {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        for (const table of [
          "governance_export_objects",
          "governance_exports",
          "governance_review_items",
          "governance_legal_holds",
          "governance_matter_custodians",
          "governance_retention_policies",
          "governance_matters",
          "chat_message_revisions",
          "messages",
          "chat_room_settings",
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
      select to_regprocedure('helix_governance_search(uuid,uuid,uuid,text,text[],timestamptz,timestamptz,text,integer)') is not null as ready
    `;
      if (ready[0]?.ready !== true) throw new Error("Run migration 0170 before this test.");
      await cleanup();
      await sql`insert into orgs(id, slug, display_name) values (${org}, 'gov-170', 'Governance')`;
      await sql`insert into actors(id, org_id, type, email, display_name)
      values (${owner}, ${org}, 'user', 'owner@gov.test', 'Owner')`;
      await sql`insert into threads(id, org_id, kind, subject, created_by_actor_id)
      values (${thread}, ${org}, 'chat_room', 'Held project', ${owner})`;
      await sql`insert into chat_room_settings(thread_id, org_id, name)
      values (${thread}, ${org}, 'Held project')`;
      await sql`insert into messages(
        id, org_id, thread_id, actor_id, kind, body, sent_at, created_at, updated_at
      )
      values
        (${message}, ${org}, ${thread}, ${owner}, 'chat', 'discoverable after deletion',
          now(), now(), now()),
        (${expiredMessage}, ${org}, ${thread}, ${owner}, 'chat', 'expired evidence',
          now() - interval '2 days', now() - interval '2 days', now() - interval '2 days')`;
      await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
        await tx`insert into governance_matters(id, org_id, name, created_by_actor_id)
        values (${matter}, ${org}, 'Investigation', ${owner})`;
        await tx`insert into governance_matter_custodians(org_id, matter_id, actor_id, added_by_actor_id)
        values (${org}, ${matter}, ${owner}, ${owner})`;
        await tx`insert into governance_legal_holds(id, org_id, matter_id, product, reason, created_by_actor_id)
        values (${hold}, ${org}, ${matter}, 'chat', 'Preserve investigation evidence', ${owner})`;
        await tx`insert into governance_retention_policies(
        org_id, name, product, retention_days, created_by_actor_id
      ) values (${org}, 'Chat 1 day', 'chat', 1, ${owner})`;
        await tx`update messages set deleted_at = statement_timestamp(), updated_at = statement_timestamp()
        where org_id = ${org} and id in (${message}, ${expiredMessage})`;
      });
    });

    afterAll(async () => {
      await cleanup();
      await sql.end();
    });

    it("discovers user-deleted content and blocks every privileged purge until release plus expiry", async () => {
      const found = await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
        return tx<
          { readonly item_key: string; readonly snapshot: { readonly deleted_at: string | null } }[]
        >`
        select item_key, snapshot->'message' as snapshot from helix_governance_search(
          ${org}, ${owner}, ${matter}, 'discoverable', array['chat'], null, null, null, 100
        ) where item_key like '%:current-%'
      `;
      });
      expect(found[0]?.snapshot.deleted_at).not.toBeNull();
      const captured = await sql<{ readonly count: number }[]>`
      select count(*)::integer as count from governance_hold_resources
      where org_id = ${org} and hold_id = ${hold}
    `;
      expect(captured[0]?.count).toBe(2);
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
          await tx`insert into governance_review_items(
          org_id, matter_id, item_key, item_sha256, disposition, reviewed_by_actor_id
        ) values (${org}, ${matter}, 'fabricated:item', ${"0".repeat(64)}, 'responsive', ${owner})`;
        }),
      ).rejects.toThrow(/not in the matter evidence set/u);
      await expect(
        sql`delete from messages where org_id = ${org} and id = ${message}`,
      ).rejects.toThrow(/protected by retention or legal hold/u);
      await expect(
        sql`delete from messages where org_id = ${org} and id = ${expiredMessage}`,
      ).rejects.toThrow(/protected by retention or legal hold/u);
      const blockers = await sql<{ readonly blockers: readonly { readonly type: string }[] }[]>`
      select helix_tenant_deletion_blockers(${org}) as blockers
    `;
      expect(blockers[0]?.blockers.map((blocker) => blocker.type)).toEqual(
        expect.arrayContaining(["governance_legal_hold", "governance_retention"]),
      );

      await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
        await tx`update governance_legal_holds set released_at = statement_timestamp(),
        released_by_actor_id = ${owner} where org_id = ${org} and id = ${hold}`;
      });
      await expect(
        sql`delete from messages where org_id = ${org} and id = ${message}`,
      ).rejects.toThrow(/protected by retention or legal hold/u);
      await expect(
        sql`delete from messages where org_id = ${org} and id = ${expiredMessage}`,
      ).resolves.toHaveProperty("count", 1);
      await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
        await tx`update governance_retention_policies set enabled = false
        where org_id = ${org} and name = 'Chat 1 day'`;
      });
      await expect(
        sql`delete from messages where org_id = ${org} and id = ${message}`,
      ).resolves.toHaveProperty("count", 1);
    });
  },
);
