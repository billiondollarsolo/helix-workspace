import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCalendarStore } from "../../platform/calendar/store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 4, prepare: false });

describe("0137 CalDAV sync migration", () => {
  it("defines a tenant-scoped immutable tombstone log maintained by one trigger", async () => {
    const migration = await readFile(
      new URL("./0137_calendar_caldav_sync.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("primary key (calendar_id, sync_version)");
    expect(migration).toContain(
      "foreign key (org_id, calendar_id) references cal_calendars(org_id, id)",
    );
    expect(migration).toContain("create trigger cal_events_record_sync_change");
    expect(migration).toContain("alter table cal_event_changes force row level security");
    expect(migration).toContain("revoke all on cal_event_changes");
    expect(migration).toContain("grant select on cal_event_changes to helix_app, helix_worker");
  });
});

describe.skipIf(sql === null)("0137 live CalDAV sync", () => {
  const database = sql as postgres.Sql;
  const store = new PostgresCalendarStore(database);
  const orgA = "d0900000-0000-4000-8000-000000000001";
  const orgB = "d0900000-0000-4000-8000-000000000002";
  const ownerA = "d0900000-0000-4000-8000-000000000011";
  const readerA = "d0900000-0000-4000-8000-000000000012";
  const outsiderA = "d0900000-0000-4000-8000-000000000013";
  const ownerB = "d0900000-0000-4000-8000-000000000014";
  const calendarA = "d0900000-0000-4000-8000-000000000021";
  const calendarB = "d0900000-0000-4000-8000-000000000022";

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name) values
        (${orgA}, 'col09-a', 'COL 09 A'),
        (${orgB}, 'col09-b', 'COL 09 B')
    `;
    await database`
      insert into actors (id, org_id, type, email, display_name) values
        (${ownerA}, ${orgA}, 'user', 'owner@col09-a.test', 'Owner A'),
        (${readerA}, ${orgA}, 'user', 'reader@col09-a.test', 'Reader A'),
        (${outsiderA}, ${orgA}, 'user', 'outsider@col09-a.test', 'Outsider A'),
        (${ownerB}, ${orgB}, 'user', 'owner@col09-b.test', 'Owner B')
    `;
    await database`
      insert into cal_calendars (id, org_id, owner_actor_id, name) values
        (${calendarA}, ${orgA}, ${ownerA}, 'Calendar A'),
        (${calendarB}, ${orgB}, ${ownerB}, 'Calendar B')
    `;
    await database`
      insert into cal_calendar_memberships (org_id, calendar_id, actor_id, role) values
        (${orgA}, ${calendarA}, ${ownerA}, 'owner'),
        (${orgA}, ${calendarA}, ${readerA}, 'reader'),
        (${orgB}, ${calendarB}, ${ownerB}, 'owner')
    `;
    await database`
      insert into cal_events (
        id, org_id, calendar_id, uid, title, starts_at, ends_at,
        organizer_actor_id, organizer_email, starts_local, ends_local
      )
      select
        ('20000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
        ${orgA}, ${calendarA}, 'sync-' || value::text || '@col09.test',
        'Sync ' || value::text,
        '2026-10-01T12:00:00Z'::timestamptz + value * interval '1 minute',
        '2026-10-01T13:00:00Z'::timestamptz + value * interval '1 minute',
        ${ownerA}, 'owner@col09-a.test',
        to_char('2026-10-01T12:00:00'::timestamp + value * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS'),
        to_char('2026-10-01T13:00:00'::timestamp + value * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS')
      from generate_series(1, 303) value
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("pages 303 events to a stable token and converges offline edits and tombstones", async () => {
    const ownerCalendars = await store.listCalendarsForActor({ orgId: orgA, actorId: ownerA });
    const readerCalendars = await store.listCalendarsForActor({ orgId: orgA, actorId: readerA });
    const outsiderCalendars = await store.listCalendarsForActor({
      orgId: orgA,
      actorId: outsiderA,
    });
    expect(ownerCalendars.find((calendar) => calendar.id === calendarA)?.syncVersion).toBe(303);
    expect(readerCalendars.map((calendar) => calendar.id)).toContain(calendarA);
    expect(outsiderCalendars).toEqual([]);

    let version = 0;
    const eventIds = new Set<string>();
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await store.listCalendarChangesForActor({
        orgId: orgA,
        actorId: ownerA,
        calendarId: calendarA,
        afterVersion: version,
        limit: 100,
      });
      if (page === null) throw new Error("Owner lost calendar access.");
      expect(page.changes.length).toBeLessThanOrEqual(100);
      for (const change of page.changes) eventIds.add(change.eventId);
      version = page.version;
      if (!page.hasMore) break;
    }
    expect(eventIds.size).toBe(303);
    expect(version).toBe(303);

    const updatedId = syncEventId(1);
    const deletedId = syncEventId(2);
    const createdId = syncEventId(304);
    const updated = await store.updateEvent({
      orgId: orgA,
      actorId: ownerA,
      eventId: updatedId,
      expectedIcsSequence: 0,
      patch: { title: "Updated offline" },
    });
    expect(updated?.icsSequence).toBe(1);
    await expect(
      store.updateEvent({
        orgId: orgA,
        actorId: ownerA,
        eventId: updatedId,
        expectedIcsSequence: 0,
        patch: { title: "Stale overwrite" },
      }),
    ).resolves.toBeNull();
    await expect(
      store.deleteEvent({
        orgId: orgA,
        actorId: ownerA,
        eventId: deletedId,
        expectedIcsSequence: 0,
      }),
    ).resolves.not.toBeNull();
    await database`
      insert into cal_events (
        id, org_id, calendar_id, uid, title, starts_at, ends_at,
        organizer_actor_id, organizer_email, starts_local, ends_local
      ) values (
        ${createdId}, ${orgA}, ${calendarA}, 'sync-304@col09.test', 'Created offline',
        '2026-10-03T12:00:00Z', '2026-10-03T13:00:00Z',
        ${ownerA}, 'owner@col09-a.test', '2026-10-03T12:00:00', '2026-10-03T13:00:00'
      )
    `;

    const delta = await store.listCalendarChangesForActor({
      orgId: orgA,
      actorId: readerA,
      calendarId: calendarA,
      afterVersion: version,
    });
    expect(delta?.hasMore).toBe(false);
    expect(delta?.changes.map((change) => change.eventId)).toEqual([
      updatedId,
      deletedId,
      createdId,
    ]);
    expect(delta?.changes.find((change) => change.eventId === updatedId)?.event?.title).toBe(
      "Updated offline",
    );
    expect(delta?.changes.find((change) => change.eventId === deletedId)?.event).toBeNull();
    expect(delta?.latestVersion).toBe(306);
    await expect(
      store.listCalendarChangesForActor({
        orgId: orgA,
        actorId: outsiderA,
        calendarId: calendarA,
        afterVersion: 0,
      }),
    ).resolves.toBeNull();
  });

  it("records runtime-role writes but prevents direct log mutation and cross-tenant reads", async () => {
    const runtimeId = syncEventId(305);
    await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgA}, true), set_config('helix.actor_id', ${ownerA}, true)`;
      await tx`
        insert into cal_events (
          id, org_id, calendar_id, uid, title, starts_at, ends_at,
          organizer_actor_id, organizer_email, starts_local, ends_local
        ) values (
          ${runtimeId}, ${orgA}, ${calendarA}, 'sync-305@col09.test', 'Runtime write',
          '2026-10-04T12:00:00Z', '2026-10-04T13:00:00Z',
          ${ownerA}, 'owner@col09-a.test', '2026-10-04T12:00:00', '2026-10-04T13:00:00'
        )
      `;
    });
    const runtimeLog = await database<{ count: number }[]>`
      select count(*)::integer as count from cal_event_changes where event_id = ${runtimeId}
    `;
    expect(runtimeLog[0]?.count).toBe(1);

    const hidden = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgB}, true), set_config('helix.actor_id', ${ownerB}, true)`;
      return tx`select event_id from cal_event_changes where org_id = ${orgA}`;
    });
    expect(hidden).toEqual([]);

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true), set_config('helix.actor_id', ${ownerA}, true)`;
        await tx`delete from cal_event_changes where event_id = ${runtimeId}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  function syncEventId(index: number): string {
    return `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  }

  async function cleanup(): Promise<void> {
    await cleanupTestTenants(database, [orgA, orgB]);
  }
});
