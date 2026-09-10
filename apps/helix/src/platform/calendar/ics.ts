import { versionedApiPath } from "../../api/version.js";
import type { MailStore } from "../mail/index.js";
import { MailSendService } from "../mail/outbound.js";
import type { MailOutboundRecord } from "../mail/types.js";
import { recurrenceExceptionDates, recurrenceOverrides } from "./recurrence.js";
import { formatZonedIcsLocalDate } from "./timezone.js";
import type {
  CalendarAttendeeRecord,
  CalendarEventRecord,
  CalendarResponseStatus,
} from "./types.js";

export interface CalendarInvitationSender {
  sendInvitation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly event: CalendarEventRecord;
    readonly method: "REQUEST" | "CANCEL";
    readonly rsvpBaseUrl?: string | undefined;
    /** Stable durable-delivery id; retries reuse one RFC Message-ID. */
    readonly deliveryId?: string | undefined;
  }): Promise<readonly MailOutboundRecord[]>;
  sendReply?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly event: CalendarEventRecord;
    readonly attendee: CalendarAttendeeRecord;
  }): Promise<readonly MailOutboundRecord[]>;
}

export function calendarDeliveryMessageId(deliveryId: string): string {
  return `<calendar-delivery-${deliveryId}@helix.local>`;
}

export interface CreateMailCalendarInvitationSenderOptions {
  readonly store: MailStore;
  readonly defaultFromDomain?: string | undefined;
  readonly undoWindowMs?: number | undefined;
}

export function createMailCalendarInvitationSender(
  options: CreateMailCalendarInvitationSenderOptions,
): CalendarInvitationSender {
  // Event threads have kind calendar; each delivery needs a mail thread. The
  // ICS UID and durable delivery Message-ID retain the event/delivery identity.
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
              ...(input.deliveryId === undefined
                ? {}
                : { messageId: calendarDeliveryMessageId(input.deliveryId) }),
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
    ...vtimezoneLines(input.event),
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(calendarUid(input.event))}`,
    `DTSTAMP:${formatIcsDate(input.event.updatedAt)}`,
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
  for (const alarm of calendarAlarms(input.event)) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:${alarm.minutesBefore === 0 ? "PT0M" : `-PT${String(alarm.minutesBefore)}M`}`,
      `DESCRIPTION:${escapeIcsText(alarm.description ?? input.event.title)}`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  for (const override of recurrenceOverrides(input.event.metadata)) {
    const recurrenceId = new Date(override.recurrenceId);
    const startsAt = new Date(override.startsAt);
    const endsAt = new Date(override.endsAt);
    const dtstamp = new Date(override.dtstamp);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(calendarUid(input.event))}`,
      `RECURRENCE-ID${override.range === "this_and_future" ? ";RANGE=THISANDFUTURE" : ""}:${formatIcsDate(recurrenceId)}`,
      `DTSTAMP:${formatIcsDate(dtstamp)}`,
      `DTSTART:${formatIcsDate(startsAt)}`,
      `DTEND:${formatIcsDate(endsAt)}`,
      `SEQUENCE:${String(override.sequence)}`,
      `STATUS:${override.status.toUpperCase()}`,
      `SUMMARY:${escapeIcsText(override.title ?? input.event.title)}`,
    );
    if (override.description !== null && override.description !== undefined) {
      lines.push(`DESCRIPTION:${escapeIcsText(override.description)}`);
    }
    if (override.location !== null && override.location !== undefined) {
      lines.push(`LOCATION:${escapeIcsText(override.location)}`);
    }
    for (const attendee of override.attendees) {
      lines.push(attendeeToIcs({ ...attendee, actorId: null }));
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return foldIcsLines(lines).join("\r\n") + "\r\n";
}

export function createReplyIcs(
  event: CalendarEventRecord,
  attendee: CalendarAttendeeRecord,
): string {
  return createIcsCalendar({ event, attendee, method: "REPLY" });
}

function rsvpUrl(baseUrl: string, token: string, responseStatus: CalendarResponseStatus): string {
  const url = new URL(versionedApiPath(`/dav/cal/rsvp/${encodeURIComponent(token)}`), baseUrl);
  url.searchParams.set("response", responseStatus);
  return url.toString();
}

function attendeeToIcs(attendee: CalendarAttendeeRecord): string {
  const params = [
    `CN=${escapeIcsParam(attendee.displayName ?? attendee.email)}`,
    `ROLE=${icsRole(attendee.role)}`,
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

function attendeeAddress(attendee: CalendarAttendeeRecord): {
  readonly address: string;
  readonly name?: string;
} {
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

function icsRole(role: CalendarAttendeeRecord["role"]): string {
  if (role === "optional") {
    return "OPT-PARTICIPANT";
  }
  if (role === "resource") {
    return "NON-PARTICIPANT";
  }
  return "REQ-PARTICIPANT";
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
  event: Pick<CalendarEventRecord, "timezone" | "allDay" | "timeSemantics">,
): string {
  if (event.allDay) {
    return `${name};VALUE=DATE:${formatIcsDateOnly(value)}`;
  }
  if (event.timeSemantics === "floating") {
    return `${name}:${formatIcsDate(value).replace(/Z$/u, "")}`;
  }
  if (event.timezone !== undefined && event.timezone !== "UTC") {
    const local = formatZonedIcsLocalDate(value, event.timezone);
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

function vtimezoneLines(event: CalendarEventRecord): string[] {
  const timeZone = event.timezone;
  if (
    event.allDay ||
    event.timeSemantics === "floating" ||
    timeZone === undefined ||
    timeZone === "UTC"
  )
    return [];
  const startYear = event.startsAt.getUTCFullYear() - 1;
  const endYear = event.endsAt.getUTCFullYear() + 5;
  const cacheKey = `${timeZone}:${String(startYear)}:${String(endYear)}`;
  const cached = vtimezoneCache.get(cacheKey);
  if (cached !== undefined) return [...cached];
  const rangeStart = new Date(Date.UTC(startYear, 0, 1));
  const rangeEnd = new Date(Date.UTC(endYear + 1, 0, 1));
  const initialOffset = timeZoneOffsetMinutes(rangeStart, timeZone);
  if (initialOffset === null || formatZonedIcsLocalDate(rangeStart, timeZone) === null) return [];

  const transitions: { at: Date; from: number; to: number }[] = [];
  let previousAt = rangeStart;
  let previousOffset = initialOffset;
  for (
    let probe = new Date(rangeStart.getTime() + 7 * 86_400_000);
    probe <= rangeEnd;
    probe = new Date(probe.getTime() + 7 * 86_400_000)
  ) {
    const offset = timeZoneOffsetMinutes(probe, timeZone);
    if (offset !== null && offset !== previousOffset) {
      const at = findOffsetTransition(previousAt, probe, timeZone, previousOffset);
      transitions.push({ at, from: previousOffset, to: offset });
      previousOffset = offset;
    }
    previousAt = probe;
  }

  const initialKind =
    transitions[0] !== undefined && transitions[0].to < transitions[0].from
      ? "DAYLIGHT"
      : "STANDARD";
  const lines = [
    "BEGIN:VTIMEZONE",
    `TZID:${escapeIcsText(timeZone)}`,
    `X-LIC-LOCATION:${escapeIcsText(timeZone)}`,
    ...timezoneObservanceLines(initialKind, rangeStart, initialOffset, initialOffset, timeZone),
  ];
  for (const transition of transitions) {
    lines.push(
      ...timezoneObservanceLines(
        transition.to > transition.from ? "DAYLIGHT" : "STANDARD",
        transition.at,
        transition.from,
        transition.to,
        timeZone,
      ),
    );
  }
  lines.push("END:VTIMEZONE");
  if (vtimezoneCache.size >= 64) {
    const oldest = vtimezoneCache.keys().next().value;
    if (oldest !== undefined) vtimezoneCache.delete(oldest);
  }
  vtimezoneCache.set(cacheKey, lines);
  return lines;
}

const vtimezoneCache = new Map<string, readonly string[]>();

function timezoneObservanceLines(
  kind: "STANDARD" | "DAYLIGHT",
  at: Date,
  from: number,
  to: number,
  timeZone: string,
): string[] {
  return [
    `BEGIN:${kind}`,
    `DTSTART:${formatZonedIcsLocalDate(at, timeZone) ?? formatIcsDate(at).replace(/Z$/u, "")}`,
    `TZOFFSETFROM:${formatUtcOffset(from)}`,
    `TZOFFSETTO:${formatUtcOffset(to)}`,
    `TZNAME:${escapeIcsText(timeZoneName(at, timeZone))}`,
    `END:${kind}`,
  ];
}

function findOffsetTransition(from: Date, to: Date, timeZone: string, oldOffset: number): Date {
  let low = from.getTime();
  let high = to.getTime();
  while (high - low > 60_000) {
    const middle = Math.floor((low + high) / 120_000) * 60_000;
    if (timeZoneOffsetMinutes(new Date(middle), timeZone) === oldOffset) low = middle;
    else high = middle;
  }
  return new Date(high);
}

function timeZoneOffsetMinutes(value: Date, timeZone: string): number | null {
  const local = formatZonedIcsLocalDate(value, timeZone);
  if (local === null) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/u.exec(local);
  if (match === null) return null;
  const [, year = "", month = "", day = "", hour = "", minute = "", second = ""] = match;
  return Math.round(
    (Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) - value.getTime()) / 60_000,
  );
}

function formatUtcOffset(minutes: number): string {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
}

function timeZoneName(value: Date, timeZone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(value)
      .find(({ type }) => type === "timeZoneName")?.value ?? timeZone
  );
}

function calendarAlarms(
  event: CalendarEventRecord,
): readonly { readonly minutesBefore: number; readonly description?: string }[] {
  const alarms = event.metadata.alarms;
  if (!Array.isArray(alarms)) return [];
  const seen = new Set<number>();
  return alarms.flatMap((alarm) => {
    if (typeof alarm !== "object" || alarm === null) return [];
    const value = alarm as { readonly minutesBefore?: unknown; readonly description?: unknown };
    if (
      !Number.isInteger(value.minutesBefore) ||
      (value.minutesBefore as number) < 0 ||
      (value.minutesBefore as number) > 40_320 ||
      seen.has(value.minutesBefore as number)
    ) {
      return [];
    }
    const minutesBefore = value.minutesBefore as number;
    seen.add(minutesBefore);
    return [
      {
        minutesBefore,
        ...(typeof value.description === "string" && value.description.length <= 500
          ? { description: value.description }
          : {}),
      },
    ];
  });
}

function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function escapeIcsParam(value: string): string {
  return `"${value
    .replaceAll("^", "^^")
    .replace(/\r\n|\r|\n/g, "^n")
    .replaceAll('"', "^'")}"`;
}

function foldIcsLines(lines: readonly string[]): string[] {
  return lines.flatMap(foldIcsLine);
}

function foldIcsLine(line: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  let limit = 75;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limit) {
      parts.push(parts.length === 0 ? part : ` ${part}`);
      part = character;
      bytes = characterBytes;
      limit = 74;
    } else {
      part += character;
      bytes += characterBytes;
    }
  }
  parts.push(parts.length === 0 ? part : ` ${part}`);
  return parts;
}
