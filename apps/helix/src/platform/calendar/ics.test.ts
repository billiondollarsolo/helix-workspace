import { describe, expect, it } from "vitest";
import type { CreateOutboundMailInput, MailStore } from "../mail/store.js";
import type { MailOutboundRecord } from "../mail/types.js";
import { createIcsCalendar, createMailCalendarInvitationSender, createReplyIcs } from "./ics.js";
import type { CalendarEventRecord } from "./types.js";

describe("calendar ICS mail invitations", () => {
  it("emits non-UTC timed events with TZID local wall-clock values", () => {
    const ics = createIcsCalendar({
      event: {
        ...eventRecord(),
        startsAt: new Date("2026-05-21T13:30:00.000Z"),
        endsAt: new Date("2026-05-21T14:30:00.000Z"),
        timezone: "America/New_York",
      },
    });

    expect(ics).toContain('DTSTART;TZID="America/New_York":20260521T093000');
    expect(ics).toContain('DTEND;TZID="America/New_York":20260521T103000');
    expect(ics).not.toContain("DTSTART:20260521T133000Z");
  });

  it("emits all-day events as date-only DTSTART and DTEND values", () => {
    const ics = createIcsCalendar({
      event: {
        ...eventRecord(),
        startsAt: new Date("2026-05-21T00:00:00.000Z"),
        endsAt: new Date("2026-05-23T00:00:00.000Z"),
        allDay: true,
        timezone: "America/New_York",
      },
    });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260521");
    expect(ics).toContain("DTEND;VALUE=DATE:20260523");
    expect(ics).not.toContain("DTSTART;TZID");
    expect(ics).not.toContain("DTSTART:20260521T000000Z");
  });

  it("queues text/calendar invitations through the existing mail send outbox", async () => {
    const mail = new FakeMailStore();
    const sender = createMailCalendarInvitationSender({
      store: mail as unknown as MailStore,
      defaultFromDomain: "calendar.example.com",
    });

    const queued = await sender.sendInvitation({
      orgId: "org-1",
      actorId: "actor-ada",
      event: eventRecord(),
      method: "REQUEST",
      rsvpBaseUrl: "https://helix.example.com",
    });

    expect(queued).toHaveLength(2);
    expect(mail.created).toHaveLength(2);
    expect(mail.created[0]).toMatchObject({
      orgId: "org-1",
      actorId: "actor-ada",
      threadId: "thread-event-1",
      outboxSubject: "mail.send",
    });
    expect(mail.created.map((input) => input.envelope.to[0]?.address)).toEqual([
      "bruno@example.com",
      "casey@example.com",
    ]);

    const firstEnvelope = mail.created[0]?.envelope;
    expect(firstEnvelope?.from).toEqual({ address: "ada@example.com" });
    expect(firstEnvelope?.subject).toBe("Invitation: Launch review");
    expect(firstEnvelope?.text).toContain(
      "Accept: https://helix.example.com/dav/cal/rsvp/rsvp-bruno?response=accepted",
    );

    const attachment = firstEnvelope?.attachments[0];
    expect(attachment).toMatchObject({
      filename: "invite.ics",
      mimeType: "text/calendar",
      contentType: "text/calendar; method=REQUEST; charset=utf-8",
      disposition: "attachment",
    });
    const ics = attachment?.content.toString("utf8") ?? "";
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("SUMMARY:Launch review");
    expect(ics).toContain('ATTENDEE;CN="Bruno"');
    expect(ics).toContain("X-HELIX-RSVP-ACCEPT:https://helix.example.com/dav/cal/rsvp/rsvp-bruno?");
  });

  it("emits attendee-only METHOD:REPLY ICS and queues it to the organizer", async () => {
    const mail = new FakeMailStore();
    const sender = createMailCalendarInvitationSender({
      store: mail as unknown as MailStore,
      defaultFromDomain: "calendar.example.com",
    });
    const event = eventRecord();
    const baseAttendee = event.attendees[1];
    const organizer = event.attendees[0];
    const otherAttendee = event.attendees[2];
    if (baseAttendee === undefined || organizer === undefined || otherAttendee === undefined) {
      throw new Error("Expected reply attendee.");
    }
    const attendee = {
      ...baseAttendee,
      responseStatus: "accepted" as const,
      respondedAt: new Date("2026-05-20T13:00:00.000Z"),
    };

    const ics = createReplyIcs(event, attendee);
    const queued = await sender.sendReply?.({
      orgId: "org-1",
      actorId: "actor-bruno",
      event: { ...event, attendees: [organizer, attendee, otherAttendee] },
      attendee,
    });

    expect(ics).toContain("METHOD:REPLY");
    expect(ics).toContain("PARTSTAT=ACCEPTED");
    expect(ics).toContain('ATTENDEE;CN="Bruno"');
    expect(ics).not.toContain('ATTENDEE;CN="Casey"');
    expect(queued).toHaveLength(1);
    expect(mail.created[0]?.envelope).toMatchObject({
      from: { address: "bruno@example.com", name: "Bruno" },
      to: [{ address: "ada@example.com" }],
      subject: "Response: Launch review",
    });
    const attachment = mail.created[0]?.envelope.attachments[0];
    expect(attachment).toMatchObject({
      filename: "reply.ics",
      contentType: "text/calendar; method=REPLY; charset=utf-8",
    });
    expect(attachment?.content.toString("utf8")).toContain("METHOD:REPLY");
  });
});

class FakeMailStore {
  readonly created: CreateOutboundMailInput[] = [];

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    this.created.push(input);
    return {
      id: `outbound-${String(this.created.length)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      messageId: `message-${String(this.created.length)}`,
      threadId: input.threadId ?? `thread-${String(this.created.length)}`,
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

function eventRecord(): CalendarEventRecord {
  const now = new Date("2026-05-20T12:00:00.000Z");
  return {
    id: "event-1",
    orgId: "org-1",
    calendarId: "calendar-1",
    threadId: "thread-event-1",
    uid: "event-1@calendar.helix.local",
    title: "Launch review",
    description: "Review launch readiness.",
    location: "Room A",
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
      {
        actorId: null,
        email: "casey@example.com",
        displayName: "Casey",
        role: "optional",
        responseStatus: "needs_action",
        isOrganizer: false,
        rsvpToken: "rsvp-casey",
      },
    ],
  };
}
