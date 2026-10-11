import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { CreateOutboundMailInput, MailStore } from "../mail/index.js";
import type { MailOutboundRecord } from "../mail/types.js";
import { eventConferenceLink } from "./conference-link.js";
import { createIcsCalendar, createMailCalendarInvitationSender } from "./ics.js";
import { CalendarInvitationImporter, parseInboundInvitation } from "./invitation-import.js";
import type { CalendarStore } from "./store.js";
import type { CalendarEventRecord } from "./types.js";

const PUBLIC_URL = "https://helix.example.com";
const meetConference = {
  provider: "meet",
  roomId: "room-1",
  joinCode: "abc-defg-hij",
  // Stored when the room was made; the public origin is authoritative when sending.
  joinUrl: "http://localhost:3000/meet?code=abc-defg-hij",
};
const JOIN_URL = "https://helix.example.com/meet?code=abc-defg-hij";

function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/gu, "");
}

async function sendInvitation(event: CalendarEventRecord, method: "REQUEST" | "CANCEL") {
  const mail = new FakeMailStore();
  const sender = createMailCalendarInvitationSender({ store: mail as unknown as MailStore });
  await sender.sendInvitation({
    orgId: "org-1",
    actorId: "actor-ada",
    event,
    method,
    rsvpBaseUrl: PUBLIC_URL,
  });
  const envelope = mail.created[0]?.envelope;
  if (envelope === undefined) throw new Error("no invitation queued");
  return {
    envelope,
    ics: unfold(envelope.attachments[0]?.content?.toString("utf8") ?? ""),
  };
}

describe("Meet join links in calendar invitations", () => {
  it("carries the absolute join URL in DESCRIPTION, an empty LOCATION, and CONFERENCE", async () => {
    const { envelope, ics } = await sendInvitation(
      eventRecord({ location: null, metadata: { conference: meetConference } }),
      "REQUEST",
    );

    expect(ics).toContain(
      `DESCRIPTION:Review launch readiness.\\n\\nJoin with Helix Meet: ${JOIN_URL}\r\n`,
    );
    expect(ics).toContain(`LOCATION:${JOIN_URL}\r\n`);
    expect(ics).toContain(
      `CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL="Join with Helix Meet":${JOIN_URL}\r\n`,
    );
    expect(ics).toContain(`X-GOOGLE-CONFERENCE:${JOIN_URL}\r\n`);
    expect(ics).not.toContain("localhost");
    expect(envelope.text).toContain(`Join with Helix Meet: ${JOIN_URL}`);
    expect(envelope.html).toContain(`<a href="${JOIN_URL}">Join with Helix Meet</a>`);
    expect(envelope.html).toContain("Accept</a>");
  });

  it("keeps a location the organizer set and adds no link to cancellations", async () => {
    const event = eventRecord({ location: "Room A", metadata: { conference: meetConference } });
    const request = await sendInvitation(event, "REQUEST");
    expect(request.ics).toContain("LOCATION:Room A\r\n");
    expect(request.envelope.text).toContain("Where: Room A");

    const cancel = await sendInvitation(event, "CANCEL");
    expect(cancel.ics).not.toContain("CONFERENCE");
    expect(cancel.envelope.text).not.toContain("Join with Helix Meet");
  });

  it("sends plain invitations unchanged for events without a video call", async () => {
    const { envelope, ics } = await sendInvitation(eventRecord({}), "REQUEST");
    expect(ics).toContain("DESCRIPTION:Review launch readiness.\r\n");
    expect(ics).not.toContain("CONFERENCE");
    expect(envelope.text).not.toContain("Join");
  });

  it("escapes event text in the HTML part", async () => {
    const { envelope } = await sendInvitation(
      eventRecord({ title: `<img src=x onerror="alert(1)">` }),
      "REQUEST",
    );
    expect(envelope.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(envelope.html).not.toContain("<img");
  });

  it("only links http(s) URLs", () => {
    expect(
      eventConferenceLink(
        { metadata: { conference: { provider: "external", joinUrl: "javascript:alert(1)" } } },
        PUBLIC_URL,
      ),
    ).toBeNull();
    expect(
      eventConferenceLink(
        { metadata: { conference: { provider: "external", joinUrl: "https://zoom.example/j/1" } } },
        PUBLIC_URL,
      ),
    ).toEqual({
      provider: "external",
      joinUrl: "https://zoom.example/j/1",
      label: "Join video call",
    });
  });
});

describe("Join links on imported invitations", () => {
  it("reads CONFERENCE back as an external link, never as a Helix room", () => {
    const ics = createIcsCalendar({
      event: eventRecord({ location: null, metadata: { conference: meetConference } }),
      method: "REQUEST",
      conference: {
        provider: "meet",
        joinUrl: "https://other-helix.example/meet?code=abc-defg-hij",
        label: "Join with Helix Meet",
      },
    });
    const invitation = parseInboundInvitation(ics);
    expect(invitation).toMatchObject({
      method: "REQUEST",
      conference: {
        provider: "external",
        joinUrl: "https://other-helix.example/meet?code=abc-defg-hij",
      },
    });
  });

  it("falls back to X-GOOGLE-CONFERENCE, then URL, and ignores non-http links", () => {
    const google = parseInboundInvitation(
      inboundIcs(["X-GOOGLE-CONFERENCE:https://meet.example.org/xyz", "URL:https://example.org"]),
    );
    expect(google?.method === "REQUEST" && google.conference).toEqual({
      provider: "external",
      joinUrl: "https://meet.example.org/xyz",
    });
    const url = parseInboundInvitation(
      inboundIcs(["CONFERENCE;VALUE=URI:tel:+15551234567", "URL:https://zoom.example/j/9"]),
    );
    expect(url?.method === "REQUEST" && url.conference).toEqual({
      provider: "external",
      joinUrl: "https://zoom.example/j/9",
    });
    const none = parseInboundInvitation(inboundIcs(["URL:javascript:alert(1)"]));
    expect(none?.method === "REQUEST" && none.conference).toBeNull();
  });

  it("stores the link in the recipient's event metadata", async () => {
    const createEvent = vi.fn(async (input: { readonly metadata: unknown }) => ({
      id: "imported-1",
      metadata: input.metadata,
    }));
    const store = {
      createEvent,
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
      getEventForActor: vi.fn(),
    } as unknown as Pick<
      CalendarStore,
      "createEvent" | "updateEvent" | "deleteEvent" | "getEventForActor"
    >;
    const sql = Object.assign(async () => [], {
      begin: (callback: () => Promise<unknown>) => callback(),
    }) as unknown as postgres.Sql;
    const invitation = parseInboundInvitation(
      inboundIcs(["CONFERENCE;VALUE=URI;LABEL=Join:https://zoom.example/j/42"]),
    );
    if (invitation === null) throw new Error("invitation did not parse");

    await expect(
      new CalendarInvitationImporter({
        sql,
        store,
        isEnabled: async () => true,
      }).importForRecipient(
        "org-1",
        { actorId: "actor-rita", address: "rita@helix.test" },
        invitation,
        "message-1",
      ),
    ).resolves.toBe("created");
    expect(createEvent.mock.calls[0]?.[0].metadata).toMatchObject({
      source: "mail.invitation",
      conference: { provider: "external", joinUrl: "https://zoom.example/j/42" },
    });
  });
});

function inboundIcs(extra: readonly string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//External//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:standup@external.example",
    "SEQUENCE:0",
    "DTSTAMP:20261001T120000Z",
    "DTSTART:20261020T150000Z",
    "DTEND:20261020T160000Z",
    "SUMMARY:Standup",
    "ORGANIZER:mailto:olga@external.example",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:rita@helix.test",
    ...extra,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

class FakeMailStore {
  readonly created: CreateOutboundMailInput[] = [];

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    this.created.push(input);
    return {
      id: `outbound-${String(this.created.length)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      messageId: `message-${String(this.created.length)}`,
      threadId: `thread-${String(this.created.length)}`,
      outboxId: `outbox-${String(this.created.length)}`,
      status: "queued",
      envelope: input.envelope,
      undoUntil: input.undoUntil,
      sentAt: null,
      cancelledAt: null,
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      deliveryMetadata: {},
      createdAt: new Date("2026-05-20T12:00:00.000Z"),
      updatedAt: new Date("2026-05-20T12:00:00.000Z"),
    };
  }
}

function eventRecord(overrides: Partial<CalendarEventRecord>): CalendarEventRecord {
  const now = new Date("2026-05-20T12:00:00.000Z");
  return {
    id: "event-1",
    orgId: "org-1",
    calendarId: "calendar-1",
    threadId: "thread-event-1",
    uid: "event-1@calendar.helix.local",
    title: "Launch review",
    description: "Review launch readiness.",
    location: null,
    startsAt: new Date("2026-05-21T15:00:00.000Z"),
    endsAt: new Date("2026-05-21T16:00:00.000Z"),
    timezone: "UTC",
    allDay: false,
    status: "confirmed",
    recurrenceRule: null,
    organizerActorId: "actor-ada",
    organizerEmail: "ada@example.com",
    icsSequence: 0,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    attendees: [
      {
        actorId: "actor-ada",
        email: "ada@example.com",
        displayName: "Ada",
        role: "required",
        responseStatus: "accepted",
        isOrganizer: true,
        rsvpToken: "rsvp-ada",
      },
      {
        actorId: "actor-bruno",
        email: "bruno@example.com",
        displayName: "Bruno",
        role: "required",
        responseStatus: "needs_action",
        isOrganizer: false,
        rsvpToken: "rsvp-bruno",
      },
    ],
    ...overrides,
  };
}
