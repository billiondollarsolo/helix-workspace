import type { Actor } from "@helix/sdk-types";
import fastify, { type InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { createIcsCalendar } from "./ics.js";
import { registerCalendarRoutes } from "./routes.js";
import type { CalendarInvitationSender } from "./ics.js";
import type {
  CalendarAttendeeInput,
  CalendarStore,
  CreateCalendarEventInput,
  UpdateCalendarEventInput,
} from "./store.js";
import type {
  CalendarAttendeeRecord,
  CalendarEventRecord,
  CalendarFindTimeSlot,
  CalendarListEntry,
} from "./types.js";

describe("CalDAV calendar routes", () => {
  it("serves CalDAV discovery properties and respects PROPFIND depth", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000301";
    await store.createEvent({
      id: eventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Discovery planning",
      startsAt: new Date("2026-05-21T15:00:00.000Z"),
      endsAt: new Date("2026-05-21T16:00:00.000Z"),
      attendees: [],
    });
    const app = fastify();
    const invitationSender = new FakeInvitationSender();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor, invitationSender });

    const depthZero = await app.inject({
      method: "PROPFIND",
      url: "/dav/cal/",
      headers: {
        authorization: basicAuth(),
        depth: "0",
        "content-type": "application/xml",
      },
      payload: [
        '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        "  <D:prop>",
        "    <D:current-user-principal/>",
        "    <C:calendar-home-set/>",
        "    <D:resourcetype/>",
        "  </D:prop>",
        "</D:propfind>",
      ].join("\n"),
    } as unknown as InjectOptions);

    expect(depthZero.statusCode).toBe(207);
    expect(depthZero.body).toContain("<D:current-user-principal>");
    expect(depthZero.body).toContain(`/dav/cal/principals/00000000-0000-4000-8000-000000000001/`);
    expect(depthZero.body).toContain("<C:calendar-home-set>");
    expect(depthZero.body).toContain("<D:collection/><C:calendar/>");
    expect(depthZero.body).toContain("<D:supported-report-set>");
    expect(depthZero.body).toContain("<C:calendar-query/>");
    expect(depthZero.body).toContain("<C:calendar-multiget/>");
    expect(depthZero.body).not.toContain(`${eventId}.ics`);

    const depthOne = await app.inject({
      method: "PROPFIND",
      url: `/dav/cal/${calendarId}/`,
      headers: {
        authorization: basicAuth(),
        depth: "1",
        "content-type": "application/xml",
      },
      payload: '<D:propfind xmlns:D="DAV:" />',
    } as unknown as InjectOptions);

    expect(depthOne.statusCode).toBe(207);
    expect(depthOne.body).toContain(`/dav/cal/${calendarId}/`);
    expect(depthOne.body).toContain(`/dav/cal/${calendarId}/${eventId}.ics`);
    expect(depthOne.body).toContain(`<D:getetag>&quot;${eventId}-0&quot;</D:getetag>`);
  });

  it("serves the current-user principal discovery resource without event members", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    await store.createEvent({
      id: "00000000-0000-4000-8000-000000000301",
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId: "00000000-0000-4000-8000-000000000101",
      title: "Hidden from principal response",
      startsAt: new Date("2026-05-21T15:00:00.000Z"),
      endsAt: new Date("2026-05-21T16:00:00.000Z"),
      attendees: [],
    });
    const app = fastify();
    const invitationSender = new FakeInvitationSender();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor, invitationSender });

    const response = await app.inject({
      method: "PROPFIND",
      url: "/dav/cal/principals/00000000-0000-4000-8000-000000000001/",
      headers: {
        authorization: basicAuth(),
        depth: "1",
        "content-type": "application/xml",
      },
      payload: '<D:propfind xmlns:D="DAV:" />',
    } as unknown as InjectOptions);

    expect(response.statusCode).toBe(207);
    expect(response.body).toContain("<D:principal/>");
    expect(response.body).toContain("<C:calendar-home-set>");
    expect(response.body).not.toContain(".ics");
  });

  it("requires write-scoped app passwords for CalDAV mutations", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    store.allowedScopes = ["calendar.read"];
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const readResponse = await app.inject({
      method: "PROPFIND",
      url: "/dav/cal/",
      headers: {
        authorization: basicAuth(),
        depth: "0",
        "content-type": "application/xml",
      },
      payload: '<D:propfind xmlns:D="DAV:" />',
    } as unknown as InjectOptions);
    const writeResponse = await app.inject({
      method: "PUT",
      url: "/dav/cal/00000000-0000-4000-8000-000000000101/00000000-0000-4000-8000-000000000201.ics",
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
      },
      payload: createIcsCalendar({
        event: eventRecord({
          id: "00000000-0000-4000-8000-000000000201",
          calendarId: "00000000-0000-4000-8000-000000000101",
          title: "Read-only app password should not write",
        }),
      }),
    } as unknown as InjectOptions);

    expect(readResponse.statusCode).toBe(207);
    expect(writeResponse.statusCode).toBe(401);
    expect(writeResponse.body).toBe("CalDAV app password required.");
    expect(store.authScopes).toEqual(["calendar.read", "calendar.write"]);
  });

  it("creates an addressed event from a VEVENT PUT", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000201";
    const ics = createIcsCalendar({
      event: eventRecord({
        id: eventId,
        calendarId,
        title: "CalDAV planning",
        description: "Review CalDAV PUT support.",
        location: "Room 12",
        recurrenceRule: "FREQ=WEEKLY;COUNT=2",
        metadata: {
          caldav: { exdate: ["2026-05-27T15:00:00.000Z"] },
        },
        attendees: [
          attendeeRecord({
            email: "ada@example.com",
            displayName: "Ada",
            responseStatus: "accepted",
            isOrganizer: true,
          }),
          attendeeRecord({
            email: "bruno@example.com",
            displayName: "Bruno",
            responseStatus: "tentative",
            isOrganizer: false,
          }),
        ],
      }),
    });

    const response = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar; charset=utf-8",
      },
      payload: ics,
    });

    const stored = store.requireEvent(eventId);
    expect(response.statusCode).toBe(201);
    expect(stored.id).toBe(eventId);
    expect(stored.calendarId).toBe(calendarId);
    expect(stored.uid).toBe(`${eventId}@calendar.helix.local`);
    expect(stored.title).toBe("CalDAV planning");
    expect(stored.description).toBe("Review CalDAV PUT support.");
    expect(stored.location).toBe("Room 12");
    expect(stored.recurrenceRule).toBe("FREQ=WEEKLY;COUNT=2");
    expect(stored.metadata).toMatchObject({
      caldav: { exdate: ["2026-05-27T15:00:00.000Z"] },
    });
    expect(stored.attendees.map((attendee) => attendee.email)).toEqual([
      "ada@example.com",
      "bruno@example.com",
    ]);
    expect(
      stored.attendees.find((attendee) => attendee.email === "bruno@example.com")?.responseStatus,
    ).toBe("tentative");
  });

  it("treats advertised actor calendar home as the default calendar alias", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const eventId = "00000000-0000-4000-8000-000000000209";
    const ics = createIcsCalendar({
      event: eventRecord({
        id: eventId,
        calendarId: actor.id,
        title: "Actor home alias",
      }),
    });

    const created = await app.inject({
      method: "PUT",
      url: `/dav/cal/${actor.id}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
        "if-none-match": "*",
      },
      payload: ics,
    } as unknown as InjectOptions);
    const queried = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${actor.id}/`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        "  <D:prop><D:getetag/><C:calendar-data/></D:prop>",
        "</C:calendar-query>",
      ].join("\n"),
    } as unknown as InjectOptions);

    expect(created.statusCode).toBe(201);
    expect(store.requireEvent(eventId).calendarId).toBe("00000000-0000-4000-8000-000000000101");
    expect(queried.statusCode).toBe(207);
    expect(store.lastListInput?.calendarId).toBeUndefined();
    expect(queried.body).toContain(`/dav/cal/00000000-0000-4000-8000-000000000101/${eventId}.ics`);
    expect(queried.body).toContain("SUMMARY:Actor home alias");
  });

  it("stores cancelled RECURRENCE-ID instances from CalDAV PUT as EXDATEs", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000203";
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${eventId}@calendar.helix.local`,
      "DTSTAMP:20260520T130000Z",
      "DTSTART:20260520T150000Z",
      "DTEND:20260520T160000Z",
      "SUMMARY:Weekly planning",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "END:VEVENT",
      "BEGIN:VEVENT",
      `UID:${eventId}@calendar.helix.local`,
      "RECURRENCE-ID:20260527T150000Z",
      "DTSTAMP:20260520T130000Z",
      "DTSTART:20260527T150000Z",
      "DTEND:20260527T160000Z",
      "SUMMARY:Weekly planning",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
      },
      payload: ics,
    });
    const stored = store.requireEvent(eventId);

    expect(putResponse.statusCode).toBe(201);
    expect(stored.recurrenceRule).toBe("FREQ=WEEKLY;COUNT=3");
    expect(stored.metadata).toMatchObject({
      caldav: { exdate: ["2026-05-27T15:00:00.000Z"] },
    });

    const reportRequest = {
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        '  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">',
        '    <C:time-range start="20260527T000000Z" end="20260528T000000Z"/>',
        "  </C:comp-filter></C:comp-filter></C:filter>",
        "</C:calendar-query>",
      ].join("\n"),
    } as unknown as InjectOptions;
    const reportResponse = await app.inject(reportRequest);

    expect(reportResponse.statusCode).toBe(207);
    expect(reportResponse.body).not.toContain(`/dav/cal/${calendarId}/${eventId}.ics`);
    expect(reportResponse.body).not.toContain("SUMMARY:Weekly planning");
  });

  it("normalizes CalDAV PUT TZID local dates to UTC instants", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000204";
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${eventId}@calendar.helix.local`,
      "DTSTAMP:20260520T130000Z",
      "DTSTART;TZID=America/New_York:20260521T093000",
      "DTEND;TZID=America/New_York:20260521T103000",
      "SUMMARY:Local planning",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "EXDATE;TZID=America/New_York:20260528T093000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
      },
      payload: ics,
    });
    const stored = store.requireEvent(eventId);

    expect(putResponse.statusCode).toBe(201);
    expect(stored.startsAt.toISOString()).toBe("2026-05-21T13:30:00.000Z");
    expect(stored.endsAt.toISOString()).toBe("2026-05-21T14:30:00.000Z");
    expect(stored.timezone).toBe("America/New_York");
    expect(stored.metadata).toMatchObject({
      caldav: { exdate: ["2026-05-28T13:30:00.000Z"] },
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: { authorization: basicAuth() },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).toContain('DTSTART;TZID="America/New_York":20260521T093000');
    expect(getResponse.body).toContain('DTEND;TZID="America/New_York":20260521T103000');
    expect(getResponse.body).toContain("EXDATE:20260528T133000Z");
  });

  it("round-trips CalDAV all-day VALUE=DATE events through PUT, GET, and date windows", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000206";
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${eventId}@calendar.helix.local`,
      "DTSTAMP:20260520T130000Z",
      "DTSTART;VALUE=DATE:20260521",
      "DTEND;VALUE=DATE:20260523",
      "SUMMARY:Offsite",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
      },
      payload: ics,
    });
    const stored = store.requireEvent(eventId);

    expect(putResponse.statusCode).toBe(201);
    expect(stored.startsAt.toISOString()).toBe("2026-05-21T00:00:00.000Z");
    expect(stored.endsAt.toISOString()).toBe("2026-05-23T00:00:00.000Z");
    expect(stored.timezone).toBe("UTC");
    expect(stored.allDay).toBe(true);

    const getResponse = await app.inject({
      method: "GET",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: { authorization: basicAuth() },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).toContain("DTSTART;VALUE=DATE:20260521");
    expect(getResponse.body).toContain("DTEND;VALUE=DATE:20260523");
    expect(getResponse.body).not.toContain("DTSTART:20260521T000000Z");

    const includedReport = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        '  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">',
        '    <C:time-range start="20260522" end="20260523"/>',
        "  </C:comp-filter></C:comp-filter></C:filter>",
        "</C:calendar-query>",
      ].join("\n"),
    } as unknown as InjectOptions);

    expect(includedReport.statusCode).toBe(207);
    expect(store.lastListInput?.startsAt?.toISOString()).toBe("2026-05-22T00:00:00.000Z");
    expect(store.lastListInput?.endsAt?.toISOString()).toBe("2026-05-23T00:00:00.000Z");
    expect(includedReport.body).toContain(`/dav/cal/${calendarId}/${eventId}.ics`);
    expect(includedReport.body).toContain("DTSTART;VALUE=DATE:20260521");

    const excludedReport = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        '  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">',
        '    <C:time-range start="20260523" end="20260524"/>',
        "  </C:comp-filter></C:comp-filter></C:filter>",
        "</C:calendar-query>",
      ].join("\n"),
    } as unknown as InjectOptions);

    expect(excludedReport.statusCode).toBe(207);
    expect(excludedReport.body).not.toContain(`/dav/cal/${calendarId}/${eventId}.ics`);
    expect(excludedReport.body).not.toContain("SUMMARY:Offsite");
  });

  it("updates an addressed event from a VEVENT PUT", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000202";
    await store.createEvent({
      id: eventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      uid: `${eventId}@calendar.helix.local`,
      title: "Old title",
      startsAt: new Date("2026-05-20T15:00:00.000Z"),
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
      attendees: [],
    });
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const ics = createIcsCalendar({
      event: eventRecord({
        id: eventId,
        calendarId,
        title: "Updated from CalDAV",
        description: "Updated body",
        location: "Room 14",
        startsAt: new Date("2026-05-21T17:00:00.000Z"),
        endsAt: new Date("2026-05-21T18:30:00.000Z"),
        attendees: [
          attendeeRecord({
            email: "casey@example.com",
            displayName: "Casey",
            responseStatus: "accepted",
            isOrganizer: false,
          }),
        ],
      }),
    });

    const response = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
      },
      payload: ics,
    });

    const stored = store.requireEvent(eventId);
    expect(response.statusCode).toBe(204);
    expect(stored.title).toBe("Updated from CalDAV");
    expect(stored.description).toBe("Updated body");
    expect(stored.location).toBe("Room 14");
    expect(stored.startsAt.toISOString()).toBe("2026-05-21T17:00:00.000Z");
    expect(stored.endsAt.toISOString()).toBe("2026-05-21T18:30:00.000Z");
    expect(stored.attendees).toMatchObject([
      { email: "casey@example.com", displayName: "Casey", responseStatus: "accepted" },
    ]);
    expect(stored.icsSequence).toBe(1);
  });

  it("rejects stale CalDAV PUT and DELETE preconditions", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000205";
    await store.createEvent({
      id: eventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Conditional planning",
      startsAt: new Date("2026-05-20T15:00:00.000Z"),
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
      attendees: [],
    });
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });
    const ics = createIcsCalendar({
      event: eventRecord({
        id: eventId,
        calendarId,
        title: "Conditional update",
      }),
    });

    const createOnlyConflict = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
        "if-none-match": "*",
      },
      payload: ics,
    } as unknown as InjectOptions);
    const stalePut = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
        "if-match": '"stale"',
      },
      payload: ics,
    } as unknown as InjectOptions);
    const currentPut = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "content-type": "text/calendar",
        "if-match": `"${eventId}-0"`,
      },
      payload: ics,
    } as unknown as InjectOptions);
    const staleDelete = await app.inject({
      method: "DELETE",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "if-match": `"${eventId}-0"`,
      },
    } as unknown as InjectOptions);
    const currentDelete = await app.inject({
      method: "DELETE",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: {
        authorization: basicAuth(),
        "if-match": `"${eventId}-1"`,
      },
    } as unknown as InjectOptions);

    expect(createOnlyConflict.statusCode).toBe(412);
    expect(stalePut.statusCode).toBe(412);
    expect(currentPut.statusCode).toBe(204);
    expect(currentPut.headers.etag).toBe(`"${eventId}-1"`);
    expect(staleDelete.statusCode).toBe(412);
    expect(currentDelete.statusCode).toBe(204);
  });

  it("serves CalDAV calendar-query REPORT with filtered calendar data", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const visibleEventId = "00000000-0000-4000-8000-000000000301";
    const excludedEventId = "00000000-0000-4000-8000-000000000302";
    await store.createEvent({
      id: visibleEventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Inside range",
      startsAt: new Date("2026-05-21T15:00:00.000Z"),
      endsAt: new Date("2026-05-21T16:00:00.000Z"),
      attendees: [],
    });
    await store.createEvent({
      id: excludedEventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Outside range",
      startsAt: new Date("2026-06-01T15:00:00.000Z"),
      endsAt: new Date("2026-06-01T16:00:00.000Z"),
      attendees: [],
    });
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const reportRequest = {
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        "  <D:prop>",
        "    <D:getetag/>",
        "    <C:calendar-data/>",
        "  </D:prop>",
        '  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">',
        '    <C:time-range start="20260521T000000Z" end="20260522T000000Z"/>',
        "  </C:comp-filter></C:comp-filter></C:filter>",
        "</C:calendar-query>",
      ].join("\n"),
    } as unknown as InjectOptions;
    const response = await app.inject(reportRequest);

    expect(response.statusCode).toBe(207);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(store.lastListInput).toMatchObject({
      calendarId,
      limit: 250,
    });
    expect(store.lastListInput?.startsAt?.toISOString()).toBe("2026-05-21T00:00:00.000Z");
    expect(store.lastListInput?.endsAt?.toISOString()).toBe("2026-05-22T00:00:00.000Z");
    expect(response.body).toContain(`/dav/cal/${calendarId}/${visibleEventId}.ics`);
    expect(response.body).toContain("<C:calendar-data>");
    expect(response.body).toContain("SUMMARY:Inside range");
    expect(response.body).toContain(`<D:getetag>&quot;${visibleEventId}-0&quot;</D:getetag>`);
    expect(response.body).not.toContain(excludedEventId);
    expect(response.body).not.toContain("SUMMARY:Outside range");
  });

  it("serves CalDAV calendar-multiget REPORT for requested hrefs", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const includedEventId = "00000000-0000-4000-8000-000000000304";
    const skippedEventId = "00000000-0000-4000-8000-000000000305";
    await store.createEvent({
      id: includedEventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Multiget planning",
      startsAt: new Date("2026-05-21T15:00:00.000Z"),
      endsAt: new Date("2026-05-21T16:00:00.000Z"),
      attendees: [],
    });
    await store.createEvent({
      id: skippedEventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Not requested",
      startsAt: new Date("2026-05-22T15:00:00.000Z"),
      endsAt: new Date("2026-05-22T16:00:00.000Z"),
      attendees: [],
    });
    const app = fastify();
    const invitationSender = new FakeInvitationSender();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor, invitationSender });

    const response = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        "  <D:prop><D:getetag/><C:calendar-data/></D:prop>",
        `  <D:href>/dav/cal/${calendarId}/${includedEventId}.ics</D:href>`,
        `  <D:href>/dav/cal/${calendarId}/missing.ics</D:href>`,
        "</C:calendar-multiget>",
      ].join("\n"),
    } as unknown as InjectOptions);

    expect(response.statusCode).toBe(207);
    expect(response.body).toContain(`/dav/cal/${calendarId}/${includedEventId}.ics`);
    expect(response.body).toContain("SUMMARY:Multiget planning");
    expect(response.body).toContain(`<D:getetag>&quot;${includedEventId}-0&quot;</D:getetag>`);
    expect(response.body).toContain(`/dav/cal/${calendarId}/missing.ics`);
    expect(response.body).toContain("HTTP/1.1 404 Not Found");
    expect(response.body).not.toContain(skippedEventId);
    expect(response.body).not.toContain("SUMMARY:Not requested");
  });

  it("returns CalDAV multiget 404 entries for malformed event hrefs", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const response = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        "  <D:prop><D:getetag/><C:calendar-data/></D:prop>",
        `  <D:href>/dav/cal/${calendarId}/missing.ics</D:href>`,
        "</C:calendar-multiget>",
      ].join("\n"),
    } as unknown as InjectOptions);

    expect(response.statusCode).toBe(207);
    expect(response.body).toContain(`/dav/cal/${calendarId}/missing.ics`);
    expect(response.body).toContain("HTTP/1.1 404 Not Found");
  });

  it("expands recurring events and skips CalDAV EXDATEs in calendar-query REPORT", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000303";
    await store.createEvent({
      id: eventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Weekly planning",
      startsAt: new Date("2026-05-20T15:00:00.000Z"),
      endsAt: new Date("2026-05-20T16:00:00.000Z"),
      recurrenceRule: "FREQ=WEEKLY;COUNT=3",
      metadata: {
        source: "caldav.put",
        caldav: { exdate: ["2026-05-27T15:00:00.000Z"] },
      },
      attendees: [],
    });
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const reportRequest = {
      method: "REPORT",
      url: `/dav/cal/${calendarId}`,
      headers: {
        authorization: basicAuth(),
        "content-type": "application/xml",
      },
      payload: [
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        '  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">',
        '    <C:time-range start="20260527T000000Z" end="20260604T000000Z"/>',
        "  </C:comp-filter></C:comp-filter></C:filter>",
        "</C:calendar-query>",
      ].join("\n"),
    } as unknown as InjectOptions;
    const response = await app.inject(reportRequest);

    expect(response.statusCode).toBe(207);
    expect(response.body).toContain(`/dav/cal/${calendarId}/${eventId}.ics`);
    expect(response.body).toContain("SUMMARY:Weekly planning");
    expect(response.body).toContain("RRULE:FREQ=WEEKLY;COUNT=3");
    expect(response.body).toContain("EXDATE:20260527T150000Z");
  });

  it("records attendee RSVP responses from invitation links", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000401";
    await store.createEvent({
      id: eventId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "RSVP planning",
      startsAt: new Date("2026-05-21T15:00:00.000Z"),
      endsAt: new Date("2026-05-21T16:00:00.000Z"),
      attendees: [{ email: "bruno@example.com", displayName: "Bruno" }],
    });
    const app = fastify();
    const invitationSender = new FakeInvitationSender();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor, invitationSender });

    const response = await app.inject({
      method: "GET",
      url: "/dav/cal/rsvp/token-bruno-example-com?response=declined",
    });

    const stored = store.requireEvent(eventId);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("RSVP recorded: declined");
    expect(
      stored.attendees.find((attendee) => attendee.email === "bruno@example.com")?.responseStatus,
    ).toBe("declined");
    expect(
      stored.attendees
        .find((attendee) => attendee.email === "bruno@example.com")
        ?.respondedAt?.toISOString(),
    ).toBe("2026-05-20T13:06:00.000Z");
    expect(invitationSender.replyInputs[0]).toMatchObject({
      orgId: actor.orgId,
      actorId: actor.id,
      event: { id: eventId },
      attendee: { email: "bruno@example.com", responseStatus: "declined" },
    });
  });

  it("returns deterministic RSVP errors for malformed and unknown links", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const malformed = await app.inject({
      method: "GET",
      url: "/dav/cal/rsvp/missing-token?response=bogus",
    });
    const response = await app.inject({
      method: "GET",
      url: "/dav/cal/rsvp/missing-token?response=accepted",
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toBe("Malformed RSVP link.");
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Unknown RSVP link.");
  });
});

class FakeInvitationSender implements CalendarInvitationSender {
  readonly replyInputs: Parameters<NonNullable<CalendarInvitationSender["sendReply"]>>[0][] = [];

  async sendInvitation(): ReturnType<CalendarInvitationSender["sendInvitation"]> {
    return [];
  }

  async sendReply(
    input: Parameters<NonNullable<CalendarInvitationSender["sendReply"]>>[0],
  ): ReturnType<NonNullable<CalendarInvitationSender["sendReply"]>> {
    this.replyInputs.push(input);
    return [];
  }
}

class FakeCalendarStore implements CalendarStore {
  readonly #events = new Map<string, CalendarEventRecord>();
  readonly authScopes: string[] = [];
  allowedScopes: readonly string[] = ["calendar.read", "calendar.write"];
  lastListInput:
    | {
        readonly calendarId?: string | undefined;
        readonly startsAt?: Date | undefined;
        readonly endsAt?: Date | undefined;
        readonly limit?: number | undefined;
      }
    | undefined;

  constructor(private readonly actor: Actor) {}

  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEventRecord> {
    const id = input.id ?? "00000000-0000-4000-8000-000000000999";
    const event = eventRecord({
      id,
      calendarId: input.calendarId ?? "00000000-0000-4000-8000-000000000101",
      uid: input.uid ?? `${id}@calendar.helix.local`,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      allDay: input.allDay,
      recurrenceRule: input.recurrenceRule ?? null,
      metadata: input.metadata ?? {},
      attendees: attendeeInputs(input.attendees ?? []),
    });
    this.#events.set(id, event);
    return event;
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null> {
    const existing = this.#events.get(input.eventId);
    if (existing === undefined) {
      return null;
    }
    const updated = {
      ...existing,
      ...input.patch,
      attendees:
        input.patch.attendees === undefined
          ? existing.attendees
          : attendeeInputs(input.patch.attendees),
      icsSequence: existing.icsSequence + 1,
      updatedAt: new Date("2026-05-20T13:05:00.000Z"),
    };
    this.#events.set(input.eventId, updated);
    return updated;
  }

  async deleteEvent(input: { readonly eventId: string }): Promise<CalendarEventRecord | null> {
    const existing = this.#events.get(input.eventId);
    if (existing === undefined) {
      return null;
    }
    this.#events.delete(input.eventId);
    return existing;
  }

  async respondToEvent(input: {
    readonly rsvpToken?: string | undefined;
    readonly responseStatus: "accepted" | "declined" | "tentative";
  }): Promise<CalendarEventRecord | null> {
    if (input.rsvpToken === undefined) {
      return null;
    }
    for (const event of this.#events.values()) {
      if (!event.attendees.some((attendee) => attendee.rsvpToken === input.rsvpToken)) {
        continue;
      }
      const updated = {
        ...event,
        attendees: event.attendees.map((attendee) =>
          attendee.rsvpToken === input.rsvpToken
            ? {
                ...attendee,
                responseStatus: input.responseStatus,
                respondedAt: new Date("2026-05-20T13:06:00.000Z"),
              }
            : attendee,
        ),
        updatedAt: new Date("2026-05-20T13:06:00.000Z"),
      };
      this.#events.set(event.id, updated);
      return updated;
    }
    return null;
  }

  async findTime(): Promise<readonly CalendarFindTimeSlot[]> {
    return [];
  }

  async getEventForActor(input: { readonly eventId: string }): Promise<CalendarEventRecord | null> {
    return this.#events.get(input.eventId) ?? null;
  }

  async listCalendarEventsForActor(input: {
    readonly calendarId?: string | undefined;
    readonly startsAt?: Date | undefined;
    readonly endsAt?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarEventRecord[]> {
    this.lastListInput = input;
    return [...this.#events.values()]
      .filter((event) => input.calendarId === undefined || event.calendarId === input.calendarId)
      .filter(
        (event) =>
          input.startsAt === undefined ||
          event.endsAt > input.startsAt ||
          event.recurrenceRule !== null,
      )
      .filter((event) => input.endsAt === undefined || event.startsAt < input.endsAt)
      .slice(0, input.limit ?? 250);
  }

  async authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
  }): Promise<Actor | null> {
    this.authScopes.push(input.requiredScope);
    return input.username === "ada@example.com" &&
      input.password === "secret" &&
      (this.allowedScopes.includes(input.requiredScope) || this.allowedScopes.includes("caldav"))
      ? this.actor
      : null;
  }

  async listCalendarsForActor(): Promise<readonly CalendarListEntry[]> {
    return [];
  }

  requireEvent(eventId: string): CalendarEventRecord {
    const event = this.#events.get(eventId);
    if (event === undefined) {
      throw new Error(`Unknown event: ${eventId}`);
    }
    return event;
  }
}

function eventRecord(input: {
  readonly id: string;
  readonly calendarId: string;
  readonly uid?: string | undefined;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly startsAt?: Date | undefined;
  readonly endsAt?: Date | undefined;
  readonly timezone?: string | undefined;
  readonly allDay?: boolean | undefined;
  readonly recurrenceRule?: string | null | undefined;
  readonly attendees?: readonly CalendarAttendeeRecord[] | undefined;
  readonly metadata?: CalendarEventRecord["metadata"] | undefined;
}): CalendarEventRecord {
  const now = new Date("2026-05-20T13:00:00.000Z");
  return {
    id: input.id,
    orgId: "org-1",
    calendarId: input.calendarId,
    threadId: null,
    uid: input.uid ?? `${input.id}@calendar.helix.local`,
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    startsAt: input.startsAt ?? new Date("2026-05-20T15:00:00.000Z"),
    endsAt: input.endsAt ?? new Date("2026-05-20T16:00:00.000Z"),
    timezone: input.timezone ?? "UTC",
    allDay: input.allDay ?? false,
    status: "confirmed",
    recurrenceRule: input.recurrenceRule ?? null,
    organizerActorId: "00000000-0000-4000-8000-000000000001",
    organizerEmail: "ada@example.com",
    icsSequence: 0,
    metadata: input.metadata ?? {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    attendees: input.attendees ?? [],
  };
}

function attendeeRecord(input: {
  readonly email: string;
  readonly displayName: string;
  readonly responseStatus: "needs_action" | "accepted" | "declined" | "tentative";
  readonly isOrganizer: boolean;
  readonly rsvpToken?: string | undefined;
  readonly respondedAt?: Date | null | undefined;
}): CalendarAttendeeRecord {
  return {
    actorId: null,
    email: input.email,
    displayName: input.displayName,
    role: "required",
    responseStatus: input.responseStatus,
    isOrganizer: input.isOrganizer,
    rsvpToken: input.rsvpToken,
    respondedAt: input.respondedAt ?? null,
    metadata: {},
  };
}

function attendeeInputs(
  inputs: readonly CalendarAttendeeInput[],
): readonly CalendarAttendeeRecord[] {
  return inputs.map((attendee) =>
    attendeeRecord({
      email: attendee.email,
      displayName: attendee.displayName ?? attendee.email,
      responseStatus: attendee.responseStatus ?? "needs_action",
      isOrganizer: false,
      rsvpToken: `token-${attendee.email.replaceAll(/[^a-z0-9]/giu, "-").replace(/-$/u, "")}`,
    }),
  );
}

function testActor(): Actor {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "org-1",
    type: "user",
    displayName: "Ada",
    email: "ada@example.com",
    scopes: ["calendar.read", "calendar.write"],
  };
}

function basicAuth(): string {
  return `Basic ${Buffer.from("ada@example.com:secret").toString("base64")}`;
}
