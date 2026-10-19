import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { cleanupTestTenants } from "./cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "./live-suite.js";

describe.skipIf(skipUnlessLiveDatabase("fixture credential cleanup"))(
  "fixture tenant cleanup",
  () => {
    it("removes fixture app passwords before their actors and retains other tenants", async () => {
      const sql = postgres(
        process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      );
      const org = randomUUID();
      const otherOrg = randomUUID();
      const actor = randomUUID();
      const otherActor = randomUUID();
      const orgs = [org, otherOrg];
      const actors = [actor, otherActor];
      try {
        for (const [fixtureOrg, fixtureActor] of [
          [org, actor],
          [otherOrg, otherActor],
        ] as const) {
          await sql`insert into orgs(id,slug,display_name) values(${fixtureOrg},${fixtureOrg},'Cleanup fixture')`;
          await sql`insert into actors(id,org_id,type,display_name,scopes)
          values(${fixtureActor},${fixtureOrg},'user','Cleanup fixture','{}')`;
          await sql`insert into app_passwords(actor_id,label,hash)
          values(${fixtureActor},'Cleanup fixture','unusable-fixture-hash')`;
        }
        await cleanupTestTenants(sql, [org]);
        expect(
          await sql`select actor_id from app_passwords where actor_id in ${sql(actors)}`,
        ).toEqual([{ actor_id: otherActor }]);
        expect(await sql`select id from actors where id=${actor}`).toHaveLength(0);
        await expect(cleanupTestTenants(sql, [])).rejects.toThrow(
          "Fixture tenant IDs are required",
        );
      } finally {
        await cleanupTestTenants(sql, orgs);
        await sql.end();
      }
    });
  },
);
