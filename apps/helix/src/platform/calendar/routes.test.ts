import type { Actor } from "@helix/sdk-types";
import fastify, { type InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import type { CalendarInvitationSender } from "./ics.js";
import { createIcsCalendar } from "./ics.js";
import { expandCalendarEventOccurrences } from "./recurrence.js";
import { registerCalendarRoutes } from "./routes.js";
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
  CalendarMembershipRecord,
} from "./types.js";

describe("CalDAV calendar routes", () => {
  it("maps malformed REPORT XML to a bounded client error", async () => {
    const actor = testActor();
    const app = fastify();
    await registerCalendarRoutes(app, {
      store: new FakeCalendarStore(actor),
      actorFromRequest: () => actor,
    });
    const response = await app.inject({
      method: "REPORT",
      url: "/dav/cal/00000000-0000-4000-8000-000000000101/",
      headers: { authorization: basicAuth(), "content-type": "application/xml" },
      payload: '<D:calendar-query xmlns:D="DAV:"><D:prop></D:calendar-query>',
    } as unknown as InjectOptions);
    expect(response.statusCode).toBe(400);
  });

  it("requires calendar.manage before exposing the membership surface", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const denied = await app.inject({
      method: "GET",
      url: "/api/calendar/calendars/00000000-0000-4000-8000-000000000101/memberships",
    });
    expect(denied.statusCode).toBe(403);

    const manager = { ...actor, scopes: [...(actor.scopes ?? []), "calendar.manage"] };
    const allowedApp = fastify();
    await registerCalendarRoutes(allowedApp, {
      store: new FakeCalendarStore(manager),
      actorFromRequest: () => manager,
    });
    const allowed = await allowedApp.inject({
      method: "GET",
      url: "/api/calendar/calendars/00000000-0000-4000-8000-000000000101/memberships",
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ memberships: [] });
  });

  it("bounds revision export and requires an optimistic sequence for restore", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const eventId = "00000000-0000-4000-8000-000000000399";
    await store.createEvent({
      id: eventId,
      orgId: actor.orgId,
      actorId: actor.id,
      title: "Revision source",
      startsAt: new Date("2026-05-21T15:00:00Z"),
      endsAt: new Date("2026-05-21T16:00:00Z"),
    });
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const oversized = await app.inject({
      method: "GET",
      url: `/api/calendar/events/${eventId}/revisions?limit=101`,
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/calendar/events/${eventId}/revisions?limit=25&beforeRevision=7`,
    });
    const invalidRestore = await app.inject({
      method: "POST",
      url: `/api/calendar/events/${eventId}/revisions/restore`,
      payload: { revision: 0 },
    });
    const restored = await app.inject({
      method: "POST",
      url: `/api/calendar/events/${eventId}/revisions/restore`,
      payload: { revision: 0, expectedIcsSequence: 0 },
    });

    expect(oversized.statusCode).toBe(400);
    expect(listed.statusCode).toBe(200);
    expect(store.listRevisionInputs).toEqual([
      expect.objectContaining({ eventId, limit: 25, beforeRevision: 7 }),
    ]);
    expect(invalidRestore.statusCode).toBe(400);
    expect(restored.statusCode).toBe(200);
    expect(store.restoreRevisionInputs).toEqual([
      expect.objectContaining({ eventId, revision: 0, expectedIcsSequence: 0 }),
    ]);
  });

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
    expect(depthZero.body).toContain("<D:resourcetype><D:collection/></D:resourcetype>");
    expect(depthZero.body).not.toContain(`${eventId}.ics`);

    const home = await app.inject({
      method: "PROPFIND",
      url: `/dav/cal/${actor.id}/`,
      headers: {
        authorization: basicAuth(),
        depth: "1",
        "content-type": "application/xml",
      },
      payload: '<D:propfind xmlns:D="DAV:" />',
    } as unknown as InjectOptions);
    expect(home.statusCode).toBe(207);
    expect(home.body).toContain(`/dav/cal/${calendarId}/`);
    expect(home.body).toContain("<D:collection/><C:calendar/>");
    expect(home.body).toContain("<D:sync-token>");
    expect(home.body).toContain("<CS:getctag>");
    expect(home.body).toContain("<D:sync-collection/>");
    expect(home.body).not.toContain(`${eventId}.ics`);

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
    const title = `CalDAV ${"\ud83d\ude80\u6771\u4eac".repeat(20)} planning`;
    const ics = createIcsCalendar({
      event: eventRecord({
        id: eventId,
        calendarId,
        title,
        description: "Review CalDAV PUT support.",
        location: "Room 12",
        startsAt: new Date("2026-05-21T13:30:00.000Z"),
        endsAt: new Date("2026-05-21T14:30:00.000Z"),
        timezone: "America/New_York",
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
    expect(stored.title).toBe(title);
    expect(stored.description).toBe("Review CalDAV PUT support.");
    expect(stored.location).toBe("Room 12");
    expect(stored.startsAt.toISOString()).toBe("2026-05-21T13:30:00.000Z");
    expect(stored.endsAt.toISOString()).toBe("2026-05-21T14:30:00.000Z");
    expect(stored.timezone).toBe("America/New_York");
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

  it("keeps the advertised calendar home distinct from writable calendar collections", async () => {
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

    expect(created.statusCode).toBe(404);
    expect(queried.statusCode).toBe(404);
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

  it("round-trips edit-this and edit-future overrides through a series edit", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000213";
    const uid = `${eventId}@calendar.helix.local`;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260520T130000Z",
      "DTSTART:20260520T150000Z",
      "DTEND:20260520T160000Z",
      "SUMMARY:Series title",
      "RRULE:FREQ=DAILY;COUNT=5",
      "END:VEVENT",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "RECURRENCE-ID:20260521T150000Z",
      "DTSTAMP:20260520T140000Z",
      "DTSTART:20260521T170000Z",
      "DTEND:20260521T180000Z",
      "SEQUENCE:3",
      "SUMMARY:One-off title",
      "ATTENDEE;PARTSTAT=DECLINED:mailto:bruno@example.com",
      "END:VEVENT",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "RECURRENCE-ID:20260522T150000Z",
      "DTSTAMP:20260520T143000Z",
      "DTSTART:20260522T150000Z",
      "DTEND:20260522T160000Z",
      "SEQUENCE:3",
      "STATUS:CANCELLED",
      "SUMMARY:Cancelled occurrence",
      "END:VEVENT",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "RECURRENCE-ID;RANGE=THISANDFUTURE:20260523T150000Z",
      "DTSTAMP:20260520T150000Z",
      "DTSTART:20260523T180000Z",
      "DTEND:20260523T190000Z",
      "SEQUENCE:4",
      "SUMMARY:Future title",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/dav/cal/${calendarId}/${eventId}.ics`,
          headers: { authorization: basicAuth(), "content-type": "text/calendar" },
          payload: ics,
        })
      ).statusCode,
    ).toBe(201);
    const created = store.requireEvent(eventId);
    expect(created.metadata).toMatchObject({
      caldav: {
        overrides: [
          {
            recurrenceId: "2026-05-21T15:00:00.000Z",
            startsAt: "2026-05-21T17:00:00.000Z",
            attendees: [{ email: "bruno@example.com", responseStatus: "declined" }],
          },
          {
            recurrenceId: "2026-05-22T15:00:00.000Z",
            status: "cancelled",
          },
          {
            recurrenceId: "2026-05-23T15:00:00.000Z",
            range: "this_and_future",
          },
        ],
      },
    });
    expect(
      expandCalendarEventOccurrences(
        created,
        new Date("2026-05-20T00:00:00Z"),
        new Date("2026-05-26T00:00:00Z"),
      ).map((occurrence) => occurrence.startsAt.toISOString()),
    ).toEqual([
      "2026-05-20T15:00:00.000Z",
      "2026-05-21T17:00:00.000Z",
      "2026-05-23T18:00:00.000Z",
      "2026-05-24T18:00:00.000Z",
    ]);

    const exported = await app.inject({
      method: "GET",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: { authorization: basicAuth() },
    });
    expect(exported.body).toContain("RECURRENCE-ID:20260521T150000Z");
    expect(exported.body).toContain("PARTSTAT=DECLINED");
    expect(exported.body).toContain("RECURRENCE-ID:20260522T150000Z");
    expect(exported.body).toContain("STATUS:CANCELLED");
    expect(exported.body).toContain("RECURRENCE-ID;RANGE=THISANDFUTURE:20260523T150000Z");

    const seriesEdit = exported.body.replace("SUMMARY:Series title", "SUMMARY:Edited series");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/dav/cal/${calendarId}/${eventId}.ics`,
          headers: {
            authorization: basicAuth(),
            "content-type": "text/calendar",
            "if-match": `"${eventId}-0"`,
          },
          payload: seriesEdit,
        })
      ).statusCode,
    ).toBe(204);
    expect(store.requireEvent(eventId)).toMatchObject({
      title: "Edited series",
      metadata: {
        caldav: {
          overrides: [
            {
              recurrenceId: "2026-05-21T15:00:00.000Z",
              attendees: [{ email: "bruno@example.com", responseStatus: "declined" }],
            },
            { recurrenceId: "2026-05-22T15:00:00.000Z", status: "cancelled" },
            { recurrenceId: "2026-05-23T15:00:00.000Z", range: "this_and_future" },
          ],
        },
      },
    });
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

  it("round-trips CalDAV floating local times without attaching a zone", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const calendarId = "00000000-0000-4000-8000-000000000101";
    const eventId = "00000000-0000-4000-8000-000000000205";
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${eventId}@calendar.helix.local`,
      "DTSTART:20260521T093000",
      "DTEND:20260521T103000",
      "SUMMARY:Floating planning",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: { authorization: basicAuth(), "content-type": "text/calendar" },
      payload: ics,
    });
    const stored = store.requireEvent(eventId);

    expect(putResponse.statusCode).toBe(201);
    expect(stored.startsAt.toISOString()).toBe("2026-05-21T09:30:00.000Z");
    expect(stored.timeSemantics).toBe("floating");

    const getResponse = await app.inject({
      method: "GET",
      url: `/dav/cal/${calendarId}/${eventId}.ics`,
      headers: { authorization: basicAuth() },
    });
    expect(getResponse.body).toContain("DTSTART:20260521T093000\r\n");
    expect(getResponse.body).not.toContain("DTSTART:20260521T093000Z");
    expect(getResponse.body).not.toContain("DTSTART;TZID");
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

  it("pages more than 250 resources and converges offline updates and tombstones", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const calendarId = "00000000-0000-4000-8000-000000000101";
    for (let index = 1; index <= 253; index += 1) {
      await store.createEvent({
        id: syncEventId(index),
        orgId: actor.orgId,
        actorId: actor.id,
        calendarId,
        title: `Sync event ${String(index)}`,
        startsAt: new Date(Date.UTC(2026, 6, 1, 12, index)),
        endsAt: new Date(Date.UTC(2026, 6, 1, 13, index)),
      });
    }
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const collection = await app.inject({
      method: "PROPFIND",
      url: `/dav/cal/${calendarId}/`,
      headers: { authorization: basicAuth(), depth: "0", "content-type": "application/xml" },
      payload: '<D:propfind xmlns:D="DAV:" />',
    } as unknown as InjectOptions);
    const currentToken = syncTokenFromXml(collection.body);
    expect(collection.body).toContain(
      `<D:getetag>&quot;calendar-${calendarId}-253&quot;</D:getetag>`,
    );
    let token: string | null = null;
    const received = new Set<string>();
    for (let pageNumber = 0; pageNumber < 4 && token !== currentToken; pageNumber += 1) {
      const page = await app.inject({
        method: "REPORT",
        url: `/dav/cal/${calendarId}/`,
        headers: { authorization: basicAuth(), "content-type": "application/xml" },
        payload: [
          '<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
          `<D:sync-token>${token ?? ""}</D:sync-token>`,
          "<D:sync-level>1</D:sync-level>",
          "<D:limit><D:nresults>100</D:nresults></D:limit>",
          "<D:prop><D:getetag/><C:calendar-data/></D:prop>",
          "</D:sync-collection>",
        ].join(""),
      } as unknown as InjectOptions);
      expect(page.statusCode).toBe(207);
      for (const id of eventIdsFromXml(page.body)) received.add(id);
      token = syncTokenFromXml(page.body);
      if (token !== currentToken) {
        expect(page.body).toContain("<D:number-of-matches-within-limits/>");
      }
    }
    expect(token).toBe(currentToken);
    expect(received.size).toBe(253);
    if (token === null) throw new Error("Initial CalDAV sync did not return a token.");

    const updatedId = syncEventId(1);
    const deletedId = syncEventId(2);
    const createdId = syncEventId(254);
    await store.updateEvent({
      orgId: actor.orgId,
      actorId: actor.id,
      eventId: updatedId,
      patch: { title: "Updated while offline" },
    });
    await store.deleteEvent({ orgId: actor.orgId, actorId: actor.id, eventId: deletedId });
    await store.createEvent({
      id: createdId,
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId,
      title: "Created while offline",
      startsAt: new Date("2026-07-02T12:00:00Z"),
      endsAt: new Date("2026-07-02T13:00:00Z"),
    });
    const delta = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}/`,
      headers: { authorization: basicAuth(), "content-type": "application/xml" },
      payload: [
        '<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
        `<D:sync-token>${token}</D:sync-token>`,
        "<D:sync-level>1</D:sync-level>",
        "<D:prop><D:getetag/><C:calendar-data/></D:prop>",
        "</D:sync-collection>",
      ].join(""),
    } as unknown as InjectOptions);
    expect(delta.statusCode).toBe(207);
    expect(delta.body).toContain("SUMMARY:Updated while offline");
    expect(delta.body).toContain("SUMMARY:Created while offline");
    expect(delta.body).toContain(`/dav/cal/${calendarId}/${deletedId}.ics`);
    expect(delta.body).toContain("HTTP/1.1 404 Not Found");
    expect(syncTokenFromXml(delta.body)).not.toBe(token);

    const wrongCollectionToken = token.replace(calendarId, actor.id);
    const rejected = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}/`,
      headers: { authorization: basicAuth(), "content-type": "application/xml" },
      payload: `<D:sync-collection xmlns:D="DAV:"><D:sync-token>${wrongCollectionToken}</D:sync-token></D:sync-collection>`,
    } as unknown as InjectOptions);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body).toContain("<D:valid-sync-token/>");

    store.hiddenCalendarIds.add(calendarId);
    const revoked = await app.inject({
      method: "REPORT",
      url: `/dav/cal/${calendarId}/`,
      headers: { authorization: basicAuth(), "content-type": "application/xml" },
      payload: '<D:sync-collection xmlns:D="DAV:"><D:sync-token /></D:sync-collection>',
    } as unknown as InjectOptions);
    expect(revoked.statusCode).toBe(404);
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

    const confirmation = await app.inject({
      method: "GET",
      url: "/dav/cal/rsvp/token-bruno-example-com?response=declined",
    });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(confirmation.body).toContain("Respond to invitation");
    expect(
      store
        .requireEvent(eventId)
        .attendees.find((attendee) => attendee.email === "bruno@example.com")?.responseStatus,
    ).toBe("needs_action");

    const response = await app.inject({
      method: "POST",
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

    const replay = await app.inject({
      method: "POST",
      url: "/dav/cal/rsvp/token-bruno-example-com?response=accepted",
    });
    expect(replay.statusCode).toBe(404);
    expect(
      store
        .requireEvent(eventId)
        .attendees.find((attendee) => attendee.email === "bruno@example.com")?.responseStatus,
    ).toBe("declined");
    expect(invitationSender.replyInputs).toHaveLength(1);
  });

  it("returns deterministic RSVP errors for malformed and unknown links", async () => {
    const actor = testActor();
    const store = new FakeCalendarStore(actor);
    const app = fastify();
    await registerCalendarRoutes(app, { store, actorFromRequest: () => actor });

    const malformed = await app.inject({
      method: "POST",
      url: "/dav/cal/rsvp/missing-token?response=bogus",
    });
    const response = await app.inject({
      method: "POST",
      url: "/dav/cal/rsvp/missing-token?response=accepted",
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toBe("Malformed RSVP response.");
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
  readonly #calendarIds = new Set(["00000000-0000-4000-8000-000000000101"]);
  readonly #changes: {
    readonly calendarId: string;
    readonly eventId: string;
    readonly version: number;
    readonly deleted: boolean;
  }[] = [];
  readonly #versions = new Map<string, number>();
  readonly authScopes: string[] = [];
  readonly hiddenCalendarIds = new Set<string>();
  readonly listRevisionInputs: Parameters<CalendarStore["listEventRevisions"]>[0][] = [];
  readonly restoreRevisionInputs: Parameters<CalendarStore["restoreEventRevision"]>[0][] = [];
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
      timeSemantics: input.timeSemantics,
      recurrenceRule: input.recurrenceRule ?? null,
      metadata: input.metadata ?? {},
      attendees: attendeeInputs(input.attendees ?? []),
    });
    this.#events.set(id, event);
    this.#calendarIds.add(event.calendarId);
    this.#recordChange(event.calendarId, id, false);
    return event;
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null> {
    const existing = this.#events.get(input.eventId);
    if (
      existing === undefined ||
      (input.expectedIcsSequence !== undefined &&
        input.expectedIcsSequence !== existing.icsSequence)
    ) {
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
    this.#recordChange(updated.calendarId, updated.id, false);
    return updated;
  }

  async deleteEvent(input: {
    readonly orgId?: string | undefined;
    readonly actorId?: string | undefined;
    readonly eventId: string;
    readonly expectedIcsSequence?: number | undefined;
  }): Promise<CalendarEventRecord | null> {
    const existing = this.#events.get(input.eventId);
    if (
      existing === undefined ||
      (input.expectedIcsSequence !== undefined &&
        input.expectedIcsSequence !== existing.icsSequence)
    ) {
      return null;
    }
    this.#events.delete(input.eventId);
    this.#recordChange(existing.calendarId, existing.id, true);
    return existing;
  }

  async listEventRevisions(
    input: Parameters<CalendarStore["listEventRevisions"]>[0],
  ): Promise<readonly []> {
    this.listRevisionInputs.push(input);
    return [];
  }

  async restoreEventRevision(
    input: Parameters<CalendarStore["restoreEventRevision"]>[0],
  ): Promise<CalendarEventRecord | null> {
    this.restoreRevisionInputs.push(input);
    return this.#events.get(input.eventId) ?? null;
  }

  async respondToEvent(input: {
    readonly actorId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly responseStatus: "accepted" | "declined" | "tentative";
  }): Promise<CalendarEventRecord | null> {
    if (input.eventId === undefined || input.actorId === undefined) {
      return null;
    }
    const event = this.#events.get(input.eventId);
    if (event === undefined) {
      return null;
    }
    const updated = {
      ...event,
      attendees: event.attendees.map((attendee) =>
        attendee.actorId === input.actorId
          ? { ...attendee, responseStatus: input.responseStatus }
          : attendee,
      ),
    };
    this.#events.set(event.id, updated);
    return updated;
  }

  async respondToRsvpToken(input: {
    readonly rsvpToken: string;
    readonly responseStatus: "accepted" | "declined" | "tentative";
  }) {
    for (const event of this.#events.values()) {
      const attendee = event.attendees.find((candidate) => candidate.rsvpToken === input.rsvpToken);
      if (attendee === undefined) {
        continue;
      }
      const responded = {
        ...attendee,
        responseStatus: input.responseStatus,
        respondedAt: new Date("2026-05-20T13:06:00.000Z"),
        rsvpToken: `consumed-${input.rsvpToken}`,
      };
      const updated = {
        ...event,
        attendees: event.attendees.map((candidate) =>
          candidate.rsvpToken === input.rsvpToken ? responded : candidate,
        ),
        updatedAt: new Date("2026-05-20T13:06:00.000Z"),
      };
      this.#events.set(event.id, updated);
      return { event: updated, attendee: responded };
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

  async listCalendarChangesForActor(input: {
    readonly calendarId: string;
    readonly afterVersion: number;
    readonly limit?: number | undefined;
  }) {
    if (this.hiddenCalendarIds.has(input.calendarId) || !this.#calendarIds.has(input.calendarId)) {
      return null;
    }
    const limit = input.limit ?? 250;
    const rows = this.#changes
      .filter(
        (change) => change.calendarId === input.calendarId && change.version > input.afterVersion,
      )
      .slice(0, limit + 1);
    const pageRows = rows.slice(0, limit);
    const latestByEvent = new Map(pageRows.map((change) => [change.eventId, change]));
    return {
      changes: [...latestByEvent.values()].map((change) => ({
        version: change.version,
        eventId: change.eventId,
        event: change.deleted ? null : (this.#events.get(change.eventId) ?? null),
      })),
      version:
        pageRows.at(-1)?.version ?? this.#versions.get(input.calendarId) ?? input.afterVersion,
      latestVersion: this.#versions.get(input.calendarId) ?? 0,
      hasMore: rows.length > limit,
    };
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
    return [...this.#calendarIds]
      .filter((id) => !this.hiddenCalendarIds.has(id))
      .map((id) => ({
        id,
        orgId: this.actor.orgId,
        name: "Calendar",
        description: null,
        timezone: "UTC",
        color: "#4f46e5",
        ownerActorId: this.actor.id,
        ownerDisplayName: this.actor.displayName ?? null,
        role: "owner",
        visible: true,
        group: "mine",
        writable: true,
        sortOrder: 0,
        eventCount: [...this.#events.values()].filter((event) => event.calendarId === id).length,
        syncVersion: this.#versions.get(id) ?? 0,
      }));
  }

  async listCalendarMemberships(): Promise<readonly CalendarMembershipRecord[]> {
    return [];
  }

  async setCalendarMembership(): Promise<CalendarMembershipRecord | null> {
    return null;
  }

  async removeCalendarMembership(): Promise<boolean> {
    return false;
  }

  requireEvent(eventId: string): CalendarEventRecord {
    const event = this.#events.get(eventId);
    if (event === undefined) {
      throw new Error(`Unknown event: ${eventId}`);
    }
    return event;
  }

  #recordChange(calendarId: string, eventId: string, deleted: boolean): void {
    const version = (this.#versions.get(calendarId) ?? 0) + 1;
    this.#versions.set(calendarId, version);
    this.#changes.push({ calendarId, eventId, version, deleted });
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
  readonly timeSemantics?: CalendarEventRecord["timeSemantics"];
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
    timeSemantics: input.timeSemantics,
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

function syncEventId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function syncTokenFromXml(xml: string): string {
  const token = /<D:sync-token>([^<]+)<\/D:sync-token>/u.exec(xml)?.[1];
  if (token === undefined) throw new Error("Expected CalDAV sync-token.");
  return token;
}

function eventIdsFromXml(xml: string): readonly string[] {
  return [...xml.matchAll(/\/([0-9a-f-]{36})\.ics/giu)].map((match) => match[1] ?? "");
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
