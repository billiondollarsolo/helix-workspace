import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { PostgresCalendarStore } from "./store.js";

const ORG = "ca7d0000-0000-4000-8000-000000000001";
const OWNER = "ca7d0000-0000-4000-8000-000000000011";
const skip = skipUnlessLiveDatabase("Default calendar");

describe("Default calendar", { skip }, () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 8, prepare: false });
    await cleanupTestTenants(sql, [ORG]);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'default-calendar', 'Default')`;
    await sql`
      insert into actors (id, org_id, type, email, display_name)
      values (${OWNER}, ${ORG}, 'user', 'ada@default-calendar.test', 'Ada Lovelace')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG]);
    await sql.end();
  });

  it("creates one primary calendar named after its owner under concurrent first events", async () => {
    const store = new PostgresCalendarStore(sql);
    const events = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.createEvent({
          orgId: ORG,
          actorId: OWNER,
          title: `First week ${String(index)}`,
          startsAt: new Date(Date.UTC(2026, 10, 2 + index, 14)),
          endsAt: new Date(Date.UTC(2026, 10, 2 + index, 15)),
        }),
      ),
    );

    const calendars = await sql<{ id: string; name: string }[]>`
      select id, name from cal_calendars where org_id = ${ORG} and owner_actor_id = ${OWNER}
    `;
    expect(calendars).toEqual([{ id: expect.any(String), name: "Ada Lovelace" }]);
    expect(new Set(events.map((event) => event.calendarId))).toEqual(new Set([calendars[0]?.id]));
  });
});
