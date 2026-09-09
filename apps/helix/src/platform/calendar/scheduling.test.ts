import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { CalendarStore } from "./store.js";
import type { CalendarEventRecord, CalendarFreeBusyStore } from "./types.js";
import { CalendarResourceConflictError, PostgresCalendarSchedulingStore } from "./scheduling.js";

describe("calendar scheduling operations", () => {
  it("combines per-person time zones, focus time, and a holiday calendar", async () => {
    const sql = querySql((query) => {
      if (query.includes("from cal_scheduling_profiles")) {
        return [
          profileRow("actor-new-york", "America/New_York", null),
          profileRow("actor-london", "Europe/London", "holiday-calendar"),
        ];
      }
      if (query.includes("from cal_events event")) {
        return [holidayRow()];
      }
      if (query.includes("from cal_resources")) {
        return [{ id: "00000000-0000-4000-8000-000000000099", timezone: "America/New_York" }];
      }
      if (query.includes("from cal_resource_bookings")) {
        return [
          {
            id: "booking-1",
            resource_id: "00000000-0000-4000-8000-000000000099",
            starts_at: new Date("2026-06-01T13:00:00Z"),
            ends_at: new Date("2026-06-01T14:00:00Z"),
          },
        ];
      }
      return [];
    });
    const calendar = calendarStore({
      async listCalendarFreeBusyEvents() {
        return [
          {
            eventId: "focus-event",
            actorId: "actor-new-york",
            startsAt: new Date("2026-06-01T14:00:00Z"),
            endsAt: new Date("2026-06-01T15:00:00Z"),
            metadata: { eventType: "focus" },
          },
        ];
      },
    });
    const store = new PostgresCalendarSchedulingStore(sql, calendar);

    const slots = await store.findTime({
      orgId: "org-1",
      actorId: "actor-new-york",
      attendeeActorIds: ["actor-london"],
      resourceIds: ["00000000-0000-4000-8000-000000000099"],
      startsAt: new Date("2026-06-01T12:00:00Z"),
      endsAt: new Date("2026-06-01T17:00:00Z"),
      durationMinutes: 60,
      incrementMinutes: 60,
      limit: 10,
    });

    expect(slots).toEqual([]);
  });

  it("returns only anonymous busy intervals when external sharing is enabled", async () => {
    const sql = querySql((query) =>
      query.includes("from cal_scheduling_profiles")
        ? [profileRow("actor-public", "UTC", null)]
        : [],
    );
    const calendar = calendarStore({
      async listCalendarFreeBusyEvents() {
        return [
          {
            eventId: "private-event-id",
            actorId: "actor-public",
            startsAt: new Date("2026-06-01T10:00:00Z"),
            endsAt: new Date("2026-06-01T11:00:00Z"),
          },
        ];
      },
    });
    const store = new PostgresCalendarSchedulingStore(sql, calendar);

    const busy = await store.externalAvailability({
      orgId: "org-1",
      targetActorId: "actor-public",
      startsAt: new Date("2026-06-01T00:00:00Z"),
      endsAt: new Date("2026-06-02T00:00:00Z"),
    });

    expect(busy).toEqual([
      {
        startsAt: new Date("2026-06-01T10:00:00Z"),
        endsAt: new Date("2026-06-01T11:00:00Z"),
      },
    ]);
    expect(JSON.stringify(busy)).not.toContain("private-event-id");
  });

  it("fails closed when external availability sharing is disabled", async () => {
    const sql = querySql((query) =>
      query.includes("from cal_scheduling_profiles")
        ? [{ ...profileRow("actor-private", "UTC", null), external_availability: "none" }]
        : [],
    );
    const store = new PostgresCalendarSchedulingStore(
      sql,
      calendarStore({
        async listCalendarFreeBusyEvents() {
          throw new Error("private calendar must not be queried");
        },
      }),
    );

    await expect(
      store.externalAvailability({
        orgId: "org-1",
        targetActorId: "actor-private",
        startsAt: new Date("2026-06-01T00:00:00Z"),
        endsAt: new Date("2026-06-02T00:00:00Z"),
      }),
    ).resolves.toBeNull();
  });

  it("maps the database overlap constraint to a deterministic booking conflict", async () => {
    const sql = querySql((query) => {
      if (query.includes("insert into cal_resource_bookings")) {
        throw Object.assign(new Error("overlap"), { code: "23P01" });
      }
      return [];
    });
    const event = eventRecord();
    const calendar = calendarStore({
      async getEventForActor() {
        return event;
      },
    });
    const store = new PostgresCalendarSchedulingStore(sql, calendar);

    await expect(
      store.requestBooking({
        orgId: event.orgId,
        actorId: event.organizerActorId ?? "",
        eventId: event.id,
        resourceId: "resource-1",
        startsAt: event.startsAt,
        endsAt: event.endsAt,
      }),
    ).rejects.toBeInstanceOf(CalendarResourceConflictError);
  });
});

function calendarStore(
  overrides: Partial<CalendarStore & CalendarFreeBusyStore>,
): CalendarStore & CalendarFreeBusyStore {
  return {
    async listCalendarFreeBusyEvents() {
      return [];
    },
    async getEventForActor() {
      return null;
    },
    ...overrides,
  } as unknown as CalendarStore & CalendarFreeBusyStore;
}

function querySql(resolver: (query: string) => readonly unknown[]): postgres.Sql {
  const tag = (strings: TemplateStringsArray) => Promise.resolve(resolver(strings.join("$")));
  return Object.assign(tag, {
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
}

function profileRow(actorId: string, timezone: string, holidayCalendarId: string | null) {
  return {
    actor_id: actorId,
    timezone,
    work_days: [1, 2, 3, 4, 5],
    work_start: "09:00:00",
    work_end: "17:00:00",
    work_location: actorId.includes("new-york") ? "New York office" : "Remote",
    external_availability: "busy",
    holiday_calendar_id: holidayCalendarId,
  };
}

function holidayRow() {
  return {
    event_id: "bank-holiday",
    calendar_id: "holiday-calendar",
    starts_at: new Date("2026-06-01T15:00:00Z"),
    ends_at: new Date("2026-06-01T16:00:00Z"),
    timezone: "Europe/London",
    all_day: false,
    time_semantics: "zoned",
    starts_local: "2026-06-01T16:00:00",
    status: "confirmed",
    recurrence_rule: null,
    metadata: { eventType: "holiday" } satisfies JsonObject,
  };
}

function eventRecord(): CalendarEventRecord {
  const startsAt = new Date("2026-06-01T13:00:00Z");
  return {
    id: "event-1",
    orgId: "org-1",
    calendarId: "calendar-1",
    uid: "event-1@helix.local",
    title: "Planning",
    startsAt,
    endsAt: new Date("2026-06-01T14:00:00Z"),
    timezone: "UTC",
    allDay: false,
    status: "confirmed",
    recurrenceRule: null,
    organizerActorId: "actor-owner",
    organizerEmail: "owner@example.com",
    icsSequence: 0,
    metadata: {},
    deletedAt: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    attendees: [],
  };
}
