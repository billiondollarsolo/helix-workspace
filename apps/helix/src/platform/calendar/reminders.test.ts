import { describe, expect, it } from "vitest";
import type { NotificationInsert, NotificationRecord } from "../notifications/types.js";
import {
  buildReminderNotifications,
  computeReminderFireAt,
  DEFAULT_REMINDER_MINUTES_BEFORE,
  dispatchDueCalendarReminders,
  InMemoryReminderDispatchLedger,
  listDueCalendarReminders,
  parseEventReminders,
  reminderDispatchKey,
} from "./reminders.js";
import type { CalendarAttendeeRecord, CalendarEventRecord } from "./types.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const actorAda = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorBruno = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const eventId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("calendar reminders (CAL.9)", () => {
  it("defaults to a 10-minute reminder when metadata is empty", () => {
    expect(parseEventReminders({})).toEqual([{ minutesBefore: DEFAULT_REMINDER_MINUTES_BEFORE }]);
    expect(parseEventReminders(undefined)).toEqual([
      { minutesBefore: DEFAULT_REMINDER_MINUTES_BEFORE },
    ]);
  });

  it("honors explicit reminder lists and opt-out empty arrays", () => {
    expect(parseEventReminders({ reminders: [{ minutesBefore: 30 }, { minutesBefore: 5 }] })).toEqual(
      [{ minutesBefore: 30 }, { minutesBefore: 5 }],
    );
    expect(parseEventReminders({ reminders: [] })).toEqual([]);
    expect(parseEventReminders({ reminderMinutesBefore: 15 })).toEqual([{ minutesBefore: 15 }]);
    expect(parseEventReminders({ reminders: [{ minutesBefore: -1 }, { minutesBefore: 1.9 }] })).toEqual(
      [{ minutesBefore: 1 }],
    );
  });

  it("computes fireAt as startsAt minus lead time", () => {
    const startsAt = new Date("2026-05-20T15:00:00.000Z");
    expect(computeReminderFireAt(startsAt, 10).toISOString()).toBe("2026-05-20T14:50:00.000Z");
    expect(computeReminderFireAt(startsAt, 0).toISOString()).toBe(startsAt.toISOString());
  });

  it("lists due reminders only inside the late window and skips cancelled events", () => {
    const startsAt = new Date("2026-05-20T15:00:00.000Z");
    const event = eventRecord({
      startsAt,
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
      metadata: { reminders: [{ minutesBefore: 10 }] },
    });
    const cancelled = eventRecord({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "cancelled",
      startsAt,
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
    });

    const early = listDueCalendarReminders({
      events: [event, cancelled],
      now: new Date("2026-05-20T14:40:00.000Z"),
    });
    expect(early).toEqual([]);

    const due = listDueCalendarReminders({
      events: [event, cancelled],
      now: new Date("2026-05-20T14:50:00.000Z"),
    });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      eventId: event.id,
      minutesBefore: 10,
      recipientActorIds: expect.arrayContaining([actorAda, actorBruno]),
    });
    expect(due[0]?.dispatchKey).toBe(
      reminderDispatchKey({
        orgId: orgA,
        eventId: event.id,
        minutesBefore: 10,
        occurrenceStartsAt: startsAt,
      }),
    );

    const tooLate = listDueCalendarReminders({
      events: [event],
      now: new Date("2026-05-20T15:20:00.000Z"),
      lateWindowMs: 15 * 60_000,
    });
    expect(tooLate).toEqual([]);
  });

  it("never surfaces cross-tenant events when orgId filter is set", () => {
    const startsAt = new Date("2026-05-20T15:00:00.000Z");
    const now = new Date("2026-05-20T14:50:00.000Z");
    const local = eventRecord({
      orgId: orgA,
      startsAt,
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
    });
    const foreign = eventRecord({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      orgId: orgB,
      organizerActorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      startsAt,
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
      attendees: [
        attendee({
          orgId: orgB,
          actorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          email: "other@example.com",
          isOrganizer: true,
        }),
      ],
    });

    const due = listDueCalendarReminders({ events: [local, foreign], now, orgId: orgA });
    expect(due.map((item) => item.orgId)).toEqual([orgA]);
    expect(due.map((item) => item.eventId)).not.toContain(foreign.id);
  });

  it("builds org-scoped notifications with calendar.reminder verb", () => {
    const due = listDueCalendarReminders({
      events: [
        eventRecord({
          startsAt: new Date("2026-05-20T15:00:00.000Z"),
          endsAt: new Date("2026-05-20T16:00:00.000Z"),
        }),
      ],
      now: new Date("2026-05-20T14:50:00.000Z"),
    })[0];
    expect(due).toBeDefined();
    if (due === undefined) {
      throw new Error("expected due reminder");
    }
    const notifications = buildReminderNotifications(due);
    expect(notifications).toHaveLength(2);
    for (const notification of notifications) {
      expect(notification.orgId).toBe(orgA);
      expect(notification.verb).toBe("calendar.reminder");
      expect(notification.objectType).toBe("calendar_event");
      expect(notification.objectId).toBe(eventId);
      expect(notification.payload).toMatchObject({
        eventId,
        minutesBefore: 10,
        dispatchKey: due.dispatchKey,
      });
    }
  });

  it("dispatches once per ledger key and skips repeats", async () => {
    const startsAt = new Date("2026-05-20T15:00:00.000Z");
    const event = eventRecord({
      startsAt,
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
    });
    const store = new RecordingNotificationStore();
    const ledger = new InMemoryReminderDispatchLedger();
    const now = new Date("2026-05-20T14:50:00.000Z");

    const first = await dispatchDueCalendarReminders({
      events: [event],
      notifications: store,
      ledger,
      now,
    });
    expect(first).toEqual({ due: 1, inserted: 2, skipped: 0 });
    expect(store.inserts).toHaveLength(2);

    const second = await dispatchDueCalendarReminders({
      events: [event],
      notifications: store,
      ledger,
      now,
    });
    expect(second).toEqual({ due: 1, inserted: 0, skipped: 1 });
    expect(store.inserts).toHaveLength(2);
  });

  it("does not insert foreign-tenant notifications even if events leak into the batch", async () => {
    const startsAt = new Date("2026-05-20T15:00:00.000Z");
    const foreign = eventRecord({
      orgId: orgB,
      organizerActorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      startsAt,
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
      attendees: [
        attendee({
          orgId: orgB,
          actorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          email: "other@example.com",
          isOrganizer: true,
        }),
      ],
    });
    const store = new RecordingNotificationStore();
    const ledger = new InMemoryReminderDispatchLedger();

    const result = await dispatchDueCalendarReminders({
      events: [foreign],
      notifications: store,
      ledger,
      now: new Date("2026-05-20T14:50:00.000Z"),
      orgId: orgA,
    });

    expect(result).toEqual({ due: 0, inserted: 0, skipped: 0 });
    expect(store.inserts).toEqual([]);
  });
});

class RecordingNotificationStore {
  readonly inserts: NotificationInsert[] = [];

  async insertMany(inputs: readonly NotificationInsert[]): Promise<readonly NotificationRecord[]> {
    this.inserts.push(...inputs);
    return inputs.map((input, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      orgId: input.orgId,
      actorId: input.actorId,
      verb: input.verb,
      objectType: input.objectType,
      objectId: input.objectId ?? null,
      summary: input.summary,
      body: input.body ?? null,
      payload: input.payload ?? {},
      createdAt: new Date("2026-05-20T14:50:00.000Z"),
      readAt: null,
    }));
  }
}

function eventRecord(
  overrides: Partial<CalendarEventRecord> & {
    readonly startsAt: Date;
    readonly endsAt: Date;
  },
): CalendarEventRecord {
  const id = overrides.id ?? eventId;
  const orgId = overrides.orgId ?? orgA;
  const organizerActorId = overrides.organizerActorId ?? actorAda;
  const attendees =
    overrides.attendees ??
    [
      attendee({
        orgId,
        eventId: id,
        actorId: organizerActorId,
        email: "ada@example.com",
        isOrganizer: true,
        responseStatus: "accepted",
      }),
      attendee({
        orgId,
        eventId: id,
        actorId: actorBruno,
        email: "bruno@example.com",
        responseStatus: "accepted",
      }),
    ];
  return {
    id,
    orgId,
    calendarId: overrides.calendarId ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: overrides.title ?? "Launch review",
    description: overrides.description ?? null,
    location: overrides.location ?? null,
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    timezone: overrides.timezone ?? "UTC",
    allDay: overrides.allDay ?? false,
    status: overrides.status ?? "confirmed",
    recurrenceRule: overrides.recurrenceRule ?? null,
    organizerActorId,
    organizerEmail: overrides.organizerEmail ?? "ada@example.com",
    icsSequence: overrides.icsSequence ?? 0,
    metadata: overrides.metadata ?? {},
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-01T00:00:00.000Z"),
    attendees,
  };
}

function attendee(
  input: Partial<CalendarAttendeeRecord> & {
    readonly email: string;
    readonly actorId: string | null;
  },
): CalendarAttendeeRecord {
  return {
    id: input.id,
    orgId: input.orgId,
    eventId: input.eventId,
    actorId: input.actorId,
    email: input.email,
    displayName: input.displayName ?? null,
    role: input.role ?? "required",
    responseStatus: input.responseStatus ?? "needs_action",
    isOrganizer: input.isOrganizer ?? false,
    metadata: input.metadata ?? {},
  };
}
