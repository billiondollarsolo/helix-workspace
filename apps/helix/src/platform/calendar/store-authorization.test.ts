import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresCalendarStore } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const calendarId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";

describe("Postgres calendar authorization", () => {
  it("requires writer authority before creating on a shared calendar", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.createEvent({
        orgId,
        actorId,
        calendarId,
        title: "Denied",
        startsAt: new Date("2026-09-02T12:00:00.000Z"),
        endsAt: new Date("2026-09-02T13:00:00.000Z"),
      }),
    ).rejects.toThrow("Unknown or inaccessible calendar");
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]).toContain("membership.role in ('owner', 'manager', 'writer')");
    expect(recording.calls[0]).toContain("p.expires_at");
  });

  it("does not let a calendar writer rewrite or cancel another organizer's event", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.updateEvent({ orgId, actorId, eventId, patch: { title: "Hijacked" } }),
    ).resolves.toBeNull();
    expect(recording.calls[0]).toContain("membership.role in ('owner', 'manager')");
    expect(recording.calls[0]).not.toContain("'manager', 'writer')");
  });

  it("requires distinct owner or manager authority to enumerate memberships", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(store.listCalendarMemberships({ orgId, actorId, calendarId })).resolves.toBeNull();
    expect(recording.calls[0]).toContain("membership.role in ('owner', 'manager')");
    expect(recording.calls[0]).toContain("permission.role in ('owner', 'manager')");
  });

  it("binds membership changes to an active same-tenant actor and preserves the owner", async () => {
    const recording = recordingSql([[{ id: calendarId }], []]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.setCalendarMembership({
        orgId,
        actorId,
        calendarId,
        memberActorId: "55555555-5555-4555-8555-555555555555",
        role: "writer",
      }),
    ).resolves.toBeNull();
    expect(recording.calls[1]).toContain("actor.org_id = $");
    expect(recording.calls[1]).toContain("org.status = 'active'");
    expect(recording.calls[1]).toContain("actor.id <> calendar.owner_actor_id");
  });

  it("matches authenticated RSVP updates only by the session actor id", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.respondToEvent({ orgId, actorId, eventId, responseStatus: "accepted" }),
    ).resolves.toBeNull();
    expect(recording.calls[0]).toContain("actor_id = $");
    expect(recording.calls[0]).not.toContain("lower(email)");
  });

  it("atomically consumes external RSVP bearer tokens", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.respondToRsvpToken({ rsvpToken: "one-use-token", responseStatus: "declined" }),
    ).resolves.toBeNull();
    expect(recording.calls[0]).toContain("where rsvp_token = $");
    expect(recording.calls[0]).toContain("rsvp_token = gen_random_uuid()::text");
    expect(recording.calls[0]).toContain("returning event_id, org_id, email");
  });

  it("rejects an inactive or cross-tenant organizer before creating event state", async () => {
    const recording = recordingSql([[calendarRow()], []]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.createEvent({
        orgId,
        actorId,
        title: "Denied",
        startsAt: new Date("2026-09-02T12:00:00.000Z"),
        endsAt: new Date("2026-09-02T13:00:00.000Z"),
      }),
    ).rejects.toThrow("active user");
    expect(recording.calls[1]).toContain("org.status = 'active'");
    expect(recording.calls[1]).toContain("actor.disabled_at is null");
    expect(recording.calls.some((call) => call.includes("insert into threads"))).toBe(false);
  });

  it("rejects an attendee actor without a canonical same-org identity", async () => {
    const recording = recordingSql([
      [calendarRow()],
      [{ email: "owner@example.com" }],
      [{ id: "55555555-5555-4555-8555-555555555555" }],
      [eventRow()],
      [],
    ]);
    const store = new PostgresCalendarStore(recording.sql);

    await expect(
      store.createEvent({
        orgId,
        actorId,
        title: "Denied attendee",
        startsAt: new Date("2026-09-02T12:00:00.000Z"),
        endsAt: new Date("2026-09-02T13:00:00.000Z"),
        attendees: [
          {
            actorId: "66666666-6666-4666-8666-666666666666",
            email: "spoofed@example.com",
          },
        ],
      }),
    ).rejects.toThrow("not active in this organization");
    expect(recording.calls.at(-1)).toContain("join orgs org");
    expect(recording.calls.some((call) => call.includes("insert into cal_attendees"))).toBe(false);
  });

  it("revokes only removed participants instead of replacing every attendee token", async () => {
    const row = eventRow();
    const organizer = attendeeRow({
      id: "55555555-5555-4555-8555-555555555551",
      actorId,
      email: "owner@example.com",
      organizer: true,
    });
    const removed = attendeeRow({
      id: "55555555-5555-4555-8555-555555555552",
      actorId: "55555555-5555-4555-8555-555555555555",
      email: "removed@example.com",
    });
    const recording = recordingSql([
      [row],
      [],
      [row],
      [{ email: "owner@example.com" }],
      [organizer, removed],
      [],
      [],
      [],
      [],
      [],
      [],
      [row],
      [organizer],
    ]);
    const store = new PostgresCalendarStore(recording.sql);

    await store.updateEvent({ orgId, actorId, eventId, patch: { attendees: [] } });
    const permissionDelete = recording.calls.findIndex((call) =>
      call.includes("delete from permissions"),
    );
    const attendeeDelete = recording.calls.findIndex((call) =>
      call.includes("delete from cal_attendees"),
    );
    expect(permissionDelete).toBeGreaterThan(-1);
    expect(attendeeDelete).toBeGreaterThan(permissionDelete);
    expect(recording.calls[permissionDelete]).toContain("role = 'participant'");
    expect(recording.calls[attendeeDelete]).toContain("where id = $");
    expect(recording.calls[attendeeDelete]).not.toContain("where event_id = $");
  });

  it("restores an immutable snapshot with attendee responses at a new sequence", async () => {
    const current = {
      ...eventRow(),
      title: "Current",
      status: "cancelled",
      deleted_at: new Date("2026-09-02T14:00:00.000Z"),
      ics_sequence: 4,
    };
    const restoredRow = { ...eventRow(), title: "Earlier", ics_sequence: 5 };
    const restoredAttendee = attendeeRow({
      id: "55555555-5555-4555-8555-555555555553",
      actorId: null,
      email: "guest@example.com",
    });
    const snapshot = {
      event: {
        ...restoredRow,
        starts_at: restoredRow.starts_at.toISOString(),
        ends_at: restoredRow.ends_at.toISOString(),
        created_at: restoredRow.created_at.toISOString(),
        updated_at: restoredRow.updated_at.toISOString(),
        ics_sequence: 1,
      },
      attendees: [
        {
          ...restoredAttendee,
          response_status: "declined",
          created_at: restoredAttendee.created_at.toISOString(),
          updated_at: restoredAttendee.updated_at.toISOString(),
        },
      ],
    };
    const recording = recordingSql([
      [current],
      [],
      [{ snapshot }],
      [restoredRow],
      [],
      [],
      [],
      [],
      [],
      [restoredRow],
      [{ ...restoredAttendee, response_status: "declined" }],
      [],
    ]);
    const store = new PostgresCalendarStore(recording.sql);

    const restored = await store.restoreEventRevision({
      orgId,
      actorId,
      eventId,
      revision: 1,
      expectedIcsSequence: 4,
    });

    expect(restored).toMatchObject({
      title: "Earlier",
      icsSequence: 5,
      attendees: [{ email: "guest@example.com", responseStatus: "declined" }],
    });
    expect(recording.calls.some((call) => call.includes("jsonb_to_recordset"))).toBe(true);
    expect(recording.calls.some((call) => call.includes("gen_random_uuid()::text"))).toBe(true);
    expect(recording.calls.at(-1)).toContain("insert into cal_event_revisions");
  });
});

function eventRow() {
  const timestamp = new Date("2026-09-02T12:00:00.000Z");
  return {
    id: eventId,
    org_id: orgId,
    calendar_id: calendarId,
    thread_id: null,
    uid: `${eventId}@helix.local`,
    title: "Planning",
    description: null,
    location: null,
    starts_at: timestamp,
    ends_at: new Date("2026-09-02T13:00:00.000Z"),
    timezone: "UTC",
    all_day: false,
    status: "confirmed",
    recurrence_rule: null,
    organizer_actor_id: actorId,
    organizer_email: "owner@example.com",
    ics_sequence: 1,
    metadata: {},
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function calendarRow() {
  const timestamp = new Date("2026-09-02T12:00:00.000Z");
  return {
    id: calendarId,
    org_id: orgId,
    owner_actor_id: actorId,
    name: "Calendar",
    color: null,
    timezone: "UTC",
    description: null,
    metadata: {},
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function attendeeRow(input: {
  readonly id: string;
  readonly actorId: string | null;
  readonly email: string;
  readonly organizer?: boolean;
}) {
  const timestamp = new Date("2026-09-02T12:00:00.000Z");
  return {
    id: input.id,
    org_id: orgId,
    event_id: eventId,
    actor_id: input.actorId,
    email: input.email,
    display_name: null,
    role: "required",
    response_status: input.organizer === true ? "accepted" : "tentative",
    is_organizer: input.organizer ?? false,
    rsvp_token: `${input.id}-token`,
    responded_at: timestamp,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function recordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray) => {
    calls.push(strings.join("$"));
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: (value: unknown) => value,
    json: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
