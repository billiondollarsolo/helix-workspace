import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { PostgresCalendarStore } from "./store.js";

const ORG = "ca7d0000-0000-4000-8000-000000000002";
const OWNER = "ca7d0000-0000-4000-8000-000000000021";
const MEMBER = "ca7d0000-0000-4000-8000-000000000022";
const skip = skipUnlessLiveDatabase("Calendar management");

describe("Calendar management", { skip }, () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 4, prepare: false });
    await cleanupTestTenants(sql, [ORG]);
    await sql`insert into orgs (id, slug, display_name) values (${ORG}, 'calendar-manage', 'Manage')`;
    await sql`
      insert into actors (id, org_id, type, email, display_name) values
        (${OWNER}, ${ORG}, 'user', 'lead@calendar-manage.test', 'Lead'),
        (${MEMBER}, ${ORG}, 'user', 'member@calendar-manage.test', 'Member')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG]);
    await sql.end();
  });

  it("creates, renames, recolors and deletes extra calendars but keeps the default", async () => {
    const store = new PostgresCalendarStore(sql);
    const team = await store.createCalendar({
      orgId: ORG,
      actorId: OWNER,
      name: "Team",
      color: "teal",
    });
    const listed = await store.listCalendarsForActor({ orgId: ORG, actorId: OWNER });
    expect(listed.map((calendar) => [calendar.name, calendar.group])).toEqual(
      expect.arrayContaining([
        ["Lead", "mine"],
        ["Team", "mine"],
      ]),
    );
    const defaultCalendar = listed.find((calendar) => calendar.name === "Lead");

    await store.setCalendarMembership({
      orgId: ORG,
      actorId: OWNER,
      calendarId: team.id,
      memberActorId: MEMBER,
      role: "manager",
    });
    // A manager may rename and recolor, but only the owner may delete.
    expect(
      await store.updateCalendar({
        orgId: ORG,
        actorId: MEMBER,
        calendarId: team.id,
        name: "Platform team",
        color: "#112233",
      }),
    ).toMatchObject({ name: "Platform team", color: "#112233" });
    expect(await store.deleteCalendar({ orgId: ORG, actorId: MEMBER, calendarId: team.id })).toBe(
      false,
    );
    expect(
      await store.updateCalendar({
        orgId: ORG,
        actorId: "ca7d0000-0000-4000-8000-0000000000ff",
        calendarId: team.id,
        name: "Hijack",
      }),
    ).toBeNull();

    expect(
      await store.deleteCalendar({
        orgId: ORG,
        actorId: OWNER,
        calendarId: defaultCalendar?.id ?? "",
      }),
    ).toBe(false);
    expect(await store.deleteCalendar({ orgId: ORG, actorId: OWNER, calendarId: team.id })).toBe(
      true,
    );
    const after = await store.listCalendarsForActor({ orgId: ORG, actorId: OWNER });
    expect(after.map((calendar) => calendar.name)).toEqual(["Lead"]);
    const audit = await sql<{ verb: string }[]>`
      select verb from activity
      where org_id = ${ORG} and verb like 'calendar.calendar.%'
      order by created_at
    `;
    expect(audit.map((row) => row.verb)).toEqual([
      "calendar.calendar.created",
      "calendar.calendar.updated",
      "calendar.calendar.deleted",
    ]);
  });
});
