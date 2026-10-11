import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const orgA = "d1990000-0000-4000-8000-00000000000a";
const orgB = "d1990000-0000-4000-8000-00000000000b";
const actorA = "d1990000-0000-4000-8000-0000000000a1";
const actorB = "d1990000-0000-4000-8000-0000000000b1";
const conversationA = "d1990000-0000-4000-8000-0000000000c1";

describe(
  "0199 assistant routines tenant keys (PostgreSQL)",
  { skip: skipUnlessLiveDatabase("assistant routines tenant keys") },
  () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("Database URL is required.");
      sql = postgres(databaseUrl, { max: 2, prepare: false });
      await cleanupTestTenants(sql, [orgA, orgB]);
      await sql`
        insert into orgs (id, slug, display_name)
        values (${orgA}, 'routine-keys-a', 'Routine keys A'), (${orgB}, 'routine-keys-b', 'Routine keys B')
      `;
      await sql`
        insert into actors (id, org_id, type, display_name)
        values (${actorA}, ${orgA}, 'user', 'Ada'), (${actorB}, ${orgB}, 'user', 'Bruno')
      `;
      await sql`
        insert into assistant_conversations (id, org_id, actor_id)
        values (${conversationA}, ${orgA}, ${actorA})
      `;
    });

    afterAll(async () => {
      await cleanupTestTenants(sql, [orgA, orgB]);
      await sql.end();
    });

    const insertRoutine = (orgId: string, actorId: string, conversationId: string | null) => sql`
      insert into assistant_routines (org_id, actor_id, conversation_id, name, prompt, interval_minutes, next_run_at)
      values (${orgId}, ${actorId}, ${conversationId}, 'Daily summary', 'Summarize my inbox', 60, now())
      returning id
    `;

    it("rejects a routine owned by an actor from another organization", async () => {
      await expect(insertRoutine(orgB, actorA, null)).rejects.toMatchObject({
        code: "23503",
        constraint_name: "assistant_routines_actor_id_fkey",
      });
    });

    it("rejects a routine linked to another organization's conversation", async () => {
      await expect(insertRoutine(orgB, actorB, conversationA)).rejects.toMatchObject({
        code: "23503",
        constraint_name: "assistant_routines_conversation_id_fkey",
      });
    });

    it("keeps the routine and its org when its conversation is deleted", async () => {
      const [routine] = await insertRoutine(orgA, actorA, conversationA);
      await sql`delete from assistant_conversations where id = ${conversationA}`;
      const rows = await sql<{ org_id: string; conversation_id: string | null }[]>`
        select org_id, conversation_id from assistant_routines where id = ${routine?.id as string}
      `;
      expect(rows).toEqual([{ org_id: orgA, conversation_id: null }]);
    });
  },
);
