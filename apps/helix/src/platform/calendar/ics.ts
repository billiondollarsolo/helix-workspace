import type {
  CalendarAttendeeRecord,
  CalendarEventRecord,
  CalendarResponseStatus,
} from "./types.js";
import { recurrenceExceptionDates } from "./recurrence.js";
import { MailSendService } from "../mail/outbound.js";
import type { MailOutboundRecord } from "../mail/types.js";
import type { MailStore } from "../mail/index.js";

export interface CalendarInvitationSender {
  sendInvitation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly event: CalendarEventRecord;
    readonly method: "REQUEST" | "CANCEL";
    readonly rsvpBaseUrl?: string | undefined;
  }): Promise<readonly MailOutboundRecord[]>;
  sendReply?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly event: CalendarEventRecord;
    readonly attendee: CalendarAttendeeRecord;
  }): Promise<readonly MailOutboundRecord[]>;
}

export interface CreateMailCalendarInvitationSenderOptions {
  readonly store: MailStore;
  readonly defaultFromDomain?: string | undefined;
  readonly undoWindowMs?: number | undefined;
}

export function createMailCalendarInvitationSender(
  options: CreateMailCalendarInvitationSenderOptions,
): CalendarInvitationSender {
  const service = new MailSendService({
    store: options.store,
    outboxSubject: "mail.send",
    undoWindowMs: options.undoWindowMs ?? 0,
  });

  return {
    async sendInvitation(input) {
      const organizer = organizerAddress(input.event, input.actorId, options.defaultFromDomain);
      const attendees = input.event.attendees.filter((attendee) => !attendee.isOrganizer);
      const queued: MailOutboundRecord[] = [];
      for (const attendee of attendees) {
        const ics = createIcsCalendar({
          event: input.event,
          method: input.method,
          attendee,
          ...(input.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: input.rsvpBaseUrl }),
        });
        queued.push(
          await service.queue({
            orgId: input.orgId,
            actorId: input.actorId,
            ...(input.event.threadId === null || input.event.threadId === undefined
              ? {}
              : { threadId: input.event.threadId }),
            envelope: {
              from: organizer,
              to: [
                {
                  address: attendee.email,
                  ...(attendee.displayName === null || attendee.displayName === undefined
                    ? {}
                    : { name: attendee.displayName }),
                },
              ],
              cc: [],
              bcc: [],
              subject: invitationSubject(input.method, input.event),
              text: invitationText(input.method, input.event, attendee, input.rsvpBaseUrl),
              attachments: [
                {
                  filename: "invite.ics",
                  mimeType: "text/calendar",
                  contentType: `text/calendar; method=${input.method}; charset=utf-8`,
                  content: Buffer.from(ics, "utf8"),
                  disposition: "attachment",
                },
              ],
            },
          }),
        );
      }
      return queued;
    },
    async sendReply(input) {
      if (input.event.organizerEmail === null || input.event.organizerEmail === undefined) {
        return [];
      }
      const ics = createReplyIcs(input.event, input.attendee);
      return [
        await service.queue({
          orgId: input.orgId,
          actorId: input.actorId,
          ...(input.event.threadId === null || input.event.threadId === undefined
            ? {}
            : { threadId: input.event.threadId }),
          envelope: {
            from: attendeeAddress(input.attendee),
            to: [organizerAddress(input.event, input.actorId, options.defaultFromDomain)],
            cc: [],
            bcc: [],
            subject: replySubject(input.event),
            text: replyText(input.event, input.attendee),
            attachments: [
              {
                filename: "reply.ics",
                mimeType: "text/calendar",
                contentType: "text/calendar; method=REPLY; charset=utf-8",
                content: Buffer.from(ics, "utf8"),
                disposition: "attachment",
              },
            ],
          },
        }),
      ];
    },
  };
}

export function createIcsCalendar(input: {
  readonly event: CalendarEventRecord;
  readonly method?: "REQUEST" | "CANCEL" | "REPLY" | undefined;
  readonly attendee?: CalendarAttendeeRecord | undefined;
  readonly rsvpBaseUrl?: string | undefined;
}): string {
  const method = input.method ?? "REQUEST";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Helix//Calendar//EN",
    `METHOD:${method}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(calendarUid(input.event))}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    formatIcsDateProperty("DTSTART", input.event.startsAt, input.event),
    formatIcsDateProperty("DTEND", input.event.endsAt, input.event),
    `SEQUENCE:${String(calendarSequence(input.event))}`,
    `STATUS:${input.event.status.toUpperCase()}`,
    `SUMMARY:${escapeIcsText(input.event.title)}`,
  ];

  if (input.event.description !== null && input.event.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeIcsText(input.event.description)}`);
  }
  if (input.event.location !== null && input.event.location !== undefined) {
    lines.push(`LOCATION:${escapeIcsText(input.event.location)}`);
  }
  const organizerEmail = input.event.organizerEmail;
  if (typeof organizerEmail === "string") {
    lines.push("ORGANIZER:mailto:" + organizerEmail);
  }
  const attendees =
    method === "REPLY" && input.attendee !== undefined ? [input.attendee] : input.event.attendees;
  for (const attendee of attendees) {
    lines.push(attendeeToIcs(attendee));
  }
  if (input.event.recurrenceRule !== null && input.event.recurrenceRule !== undefined) {
    lines.push(`RRULE:${input.event.recurrenceRule}`);
  }
  const exdates = recurrenceExceptionDates(input.event.metadata);
  if (exdates.length > 0) {
    const formattedExdates = exdates.flatMap((value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? [] : [formatIcsDate(date)];
    });
    if (formattedExdates.length > 0) {
      lines.push(`EXDATE:${formattedExdates.join(",")}`);
    }
  }
  if (
    input.attendee !== undefined &&
    input.attendee.rsvpToken !== undefined &&
    input.rsvpBaseUrl !== undefined
  ) {
    lines.push(
      `X-HELIX-RSVP-ACCEPT:${rsvpUrl(input.rsvpBaseUrl, input.attendee.rsvpToken, "accepted")}`,
    );
    lines.push(
      `X-HELIX-RSVP-TENTATIVE:${rsvpUrl(input.rsvpBaseUrl, input.attendee.rsvpToken, "tentative")}`,
    );
    lines.push(
      `X-HELIX-RSVP-DECLINE:${rsvpUrl(input.rsvpBaseUrl, input.attendee.rsvpToken, "declined")}`,
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return foldIcsLines(lines).join("\r\n") + "\r\n";
}

export function buildCalendarIcsInvitation(event: CalendarEventRecord): string {
  return createIcsCalendar({ event, method: "REQUEST" });
}

export function createReplyIcs(
  event: CalendarEventRecord,
  attendee: CalendarAttendeeRecord,
): string {
  return createIcsCalendar({ event, attendee, method: "REPLY" });
}

export function rsvpUrl(
  baseUrl: string,
  token: string,
  responseStatus: CalendarResponseStatus,
): string {
  const url = new URL(`/dav/cal/rsvp/${encodeURIComponent(token)}`, baseUrl);
  url.searchParams.set("response", responseStatus);
  return url.toString();
}

function attendeeToIcs(attendee: CalendarAttendeeRecord): string {
  const params = [
    `CN=${escapeIcsParam(attendee.displayName ?? attendee.email)}`,
    `ROLE=${attendee.role === "optional" ? "OPT-PARTICIPANT" : attendee.role === "resource" ? "NON-PARTICIPANT" : "REQ-PARTICIPANT"}`,
    `PARTSTAT=${partstat(attendee.responseStatus)}`,
    `RSVP=${attendee.responseStatus === "needs_action" ? "TRUE" : "FALSE"}`,
  ];
  return `ATTENDEE;${params.join(";")}:mailto:${attendee.email}`;
}

function invitationSubject(method: "REQUEST" | "CANCEL", event: CalendarEventRecord): string {
  return method === "CANCEL" ? `Canceled: ${event.title}` : `Invitation: ${event.title}`;
}

function replySubject(event: CalendarEventRecord): string {
  return `Response: ${event.title}`;
}

function replyText(event: CalendarEventRecord, attendee: CalendarAttendeeRecord): string {
  return [
    `${attendee.displayName ?? attendee.email} responded ${attendee.responseStatus} to ${event.title}.`,
    `When: ${event.startsAt.toISOString()} to ${event.endsAt.toISOString()}`,
  ].join("\n");
}

function invitationText(
  method: "REQUEST" | "CANCEL",
  event: CalendarEventRecord,
  attendee: CalendarAttendeeRecord,
  rsvpBaseUrl: string | undefined,
): string {
  const lines = [
    method === "CANCEL"
      ? `This event was canceled: ${event.title}`
      : `You are invited: ${event.title}`,
    `When: ${event.startsAt.toISOString()} to ${event.endsAt.toISOString()}`,
  ];
  if (event.location !== null && event.location !== undefined) {
    lines.push(`Where: ${event.location}`);
  }
  if (rsvpBaseUrl !== undefined && method === "REQUEST" && attendee.rsvpToken !== undefined) {
    lines.push(`Accept: ${rsvpUrl(rsvpBaseUrl, attendee.rsvpToken, "accepted")}`);
    lines.push(`Tentative: ${rsvpUrl(rsvpBaseUrl, attendee.rsvpToken, "tentative")}`);
    lines.push(`Decline: ${rsvpUrl(rsvpBaseUrl, attendee.rsvpToken, "declined")}`);
  }
  return lines.join("\n");
}

function organizerAddress(
  event: CalendarEventRecord,
  actorId: string,
  defaultFromDomain: string | undefined,
): { readonly address: string; readonly name?: string } {
  if (event.organizerEmail !== null && event.organizerEmail !== undefined) {
    return { address: event.organizerEmail };
  }
  if (event.organizer?.email !== undefined) {
    return {
      address: event.organizer.email,
      ...(event.organizer.displayName === undefined ? {} : { name: event.organizer.displayName }),
    };
  }
  return { address: `${actorId}@${defaultFromDomain ?? "localhost"}`, name: "Helix Calendar" };
}

function attendeeAddress(
  attendee: CalendarAttendeeRecord,
): { readonly address: string; readonly name?: string } {
  return {
    address: attendee.email,
    ...(attendee.displayName === null || attendee.displayName === undefined
      ? {}
      : { name: attendee.displayName }),
  };
}

function calendarUid(event: CalendarEventRecord): string {
  const uid = event.uid;
  if (typeof uid === "string") {
    return uid;
  }
  const icsUid = event.icsUid;
  if (typeof icsUid === "string") {
    return icsUid;
  }
  return `${event.id}@helix.local`;
}

function calendarSequence(event: CalendarEventRecord): number {
  return event.icsSequence;
}

function partstat(responseStatus: CalendarResponseStatus): string {
  if (responseStatus === "accepted") {
    return "ACCEPTED";
  }
  if (responseStatus === "declined") {
    return "DECLINED";
  }
  if (responseStatus === "tentative") {
    return "TENTATIVE";
  }
  return "NEEDS-ACTION";
}

function formatIcsDateProperty(
  name: "DTSTART" | "DTEND",
  value: Date,
  event: Pick<CalendarEventRecord, "timezone" | "allDay">,
): string {
  if (event.allDay) {
    return `${name};VALUE=DATE:${formatIcsDateOnly(value)}`;
  }
  if (event.timezone !== undefined && event.timezone !== "UTC") {
    const local = formatIcsLocalDate(value, event.timezone);
    if (local !== null) {
      return `${name};TZID=${escapeIcsParam(event.timezone)}:${local}`;
    }
  }
  return `${name}:${formatIcsDate(value)}`;
}

function formatIcsDate(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatIcsDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatIcsLocalDate(value: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((candidate) => candidate.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = part("hour");
    const minute = part("minute");
    const second = part("second");
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    ) {
      return null;
    }
    return `${year}${month}${day}T${hour}${minute}${second}`;
  } catch {
    return null;
  }
}

function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r?\n/g, "\\n");
}

function escapeIcsParam(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function foldIcsLines(lines: readonly string[]): string[] {
  const folded: string[] = [];
  for (const line of lines) {
    if (line.length <= 75) {
      folded.push(line);
      continue;
    }
    let rest = line;
    folded.push(rest.slice(0, 75));
    rest = rest.slice(75);
    while (rest.length > 0) {
      folded.push(` ${rest.slice(0, 74)}`);
      rest = rest.slice(74);
    }
  }
  return folded;
}
