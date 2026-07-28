import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import { createIcsCalendar, type CalendarInvitationSender } from "./ics.js";
import { expandCalendarEventOccurrences } from "./recurrence.js";
import type { CalendarAttendeeInput, CalendarStore } from "./store.js";
import type {
  CalendarAttendeeRecord,
  CalendarAttendeeRole,
  CalendarEventRecord,
  CalendarResponseStatus,
} from "./types.js";

const rsvpParamsSchema = z.object({ token: z.string().min(1) });
const rsvpQuerySchema = z.object({
  response: z.enum(["accepted", "declined", "tentative"]).default("accepted"),
});

export interface RegisterCalendarRoutesOptions {
  readonly store: CalendarStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly invitationSender?: CalendarInvitationSender | undefined;
}

export async function registerCalendarRoutes(
  app: FastifyInstance,
  options: RegisterCalendarRoutesOptions,
): Promise<void> {
  app.addHttpMethod("PROPFIND", { hasBody: true });
  app.addHttpMethod("REPORT", { hasBody: true });
  app.addContentTypeParser("text/calendar", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  for (const contentType of ["application/xml", "text/xml"]) {
    app.addContentTypeParser(contentType, { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get("/dav/cal/rsvp/:token", async (request, reply) => {
    const params = rsvpParamsSchema.safeParse(request.params);
    const query = rsvpQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).type("text/plain").send("Malformed RSVP link.");
    }
    const { token } = params.data;
    const { response } = query.data;
    const event = await options.store.respondToEvent({
      rsvpToken: token,
      responseStatus: response,
    });
    if (event === null) {
      return reply.code(404).type("text/plain").send("Unknown RSVP link.");
    }
    await sendRsvpReply(options, event, attendeeForRsvpToken(event, token));
    return reply.type("text/plain").send(`RSVP recorded: ${response}`);
  });

  app.route({
    method: "OPTIONS",
    url: "/dav/cal/*",
    handler: async (_request, reply) =>
      reply
        .header("DAV", "1, calendar-access")
        .header("Allow", "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE")
        .code(204)
        .send(),
  });

  app.route({
    method: ["PROPFIND", "REPORT", "GET", "PUT", "DELETE"],
    url: "/dav/cal/*",
    handler: async (request, reply) => {
      const actor = await authenticateDav(request, options.store, requiredDavScope(request.method));
      if (actor === null) {
        return reply
          .header("www-authenticate", 'Basic realm="Helix CalDAV"')
          .code(401)
          .send("CalDAV app password required.");
      }

      if (request.method === "PROPFIND") {
        const depth = propfindDepth(headerString(request.headers.depth));
        const events = await options.store.listCalendarEventsForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          limit: 250,
        });
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(propfindMultistatusXml({ actor, depth, events, requestUrl: request.url }));
      }

      if (request.method === "REPORT") {
        const bodyText = bodyToString(request.body);
        if (isCalendarMultigetReport(bodyText)) {
          const events = await calendarMultigetEvents({
            actor,
            bodyText,
            store: options.store,
          });
          return reply
            .code(207)
            .type("application/xml; charset=utf-8")
            .send(calendarMultigetMultistatusXml(events));
        }
        const timeRange = parseCalendarQueryTimeRange(bodyText);
        const calendarId = davCalendarQueryFilter(
          actor,
          parseDavCalendarCollectionTarget(request.url),
        );
        const events = await options.store.listCalendarEventsForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          ...(calendarId === undefined ? {} : { calendarId }),
          ...(timeRange.startsAt === undefined ? {} : { startsAt: timeRange.startsAt }),
          ...(timeRange.endsAt === undefined ? {} : { endsAt: timeRange.endsAt }),
          limit: 250,
        });
        const expandedEvents = eventsMatchingCalendarQuery(events, timeRange);
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(calendarQueryMultistatusXml(expandedEvents));
      }

      const target = parseDavEventTarget(request.url);
      if (target === null) {
        return reply.code(404).send("Unknown CalDAV resource.");
      }

      if (request.method === "GET") {
        const event = await options.store.getEventForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          eventId: target.eventId,
        });
        if (event === null) {
          return reply.code(404).send("Unknown calendar event.");
        }
        return reply
          .header("ETag", eventEtag(event))
          .type("text/calendar; charset=utf-8")
          .send(createIcsCalendar({ event }));
      }

      if (request.method === "DELETE") {
        const existing = await options.store.getEventForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          eventId: target.eventId,
        });
        const preconditionFailure = davPreconditionFailure(request, existing);
        if (preconditionFailure !== null) {
          return reply.code(412).send(preconditionFailure);
        }
        const deleted = await options.store.deleteEvent({
          orgId: actor.orgId,
          actorId: actor.id,
          eventId: target.eventId,
        });
        return deleted === null
          ? reply.code(404).send("Unknown calendar event.")
          : reply.code(204).send();
      }

      const parsed = parseVeventIcs(request.body);
      if (parsed === null) {
        return reply.code(400).send("CalDAV PUT requires a VEVENT calendar body.");
      }

      const existing = await options.store.getEventForActor({
        orgId: actor.orgId,
        actorId: actor.id,
        eventId: target.eventId,
      });
      const preconditionFailure = davPreconditionFailure(request, existing);
      if (preconditionFailure !== null) {
        return reply.code(412).send(preconditionFailure);
      }
      const event =
        existing === null
          ? await options.store.createEvent({
              id: target.eventId,
              orgId: actor.orgId,
              actorId: actor.id,
              calendarId: davCalendarWriteTarget(actor, target.calendarId),
              uid: parsed.uid,
              title: parsed.title,
              description: parsed.description,
              location: parsed.location,
              startsAt: parsed.startsAt,
              endsAt: parsed.endsAt,
              timezone: parsed.timezone,
              allDay: parsed.allDay,
              recurrenceRule: parsed.recurrenceRule,
              attendees: parsed.attendees,
              metadata: parsed.metadata,
            })
          : await options.store.updateEvent({
              orgId: actor.orgId,
              actorId: actor.id,
              eventId: target.eventId,
              patch: {
                title: parsed.title,
                description: parsed.description,
                location: parsed.location,
                startsAt: parsed.startsAt,
                endsAt: parsed.endsAt,
                timezone: parsed.timezone,
                allDay: parsed.allDay,
                recurrenceRule: parsed.recurrenceRule,
                attendees: parsed.attendees,
                metadata: parsed.metadata,
              },
            });

      if (event === null) {
        return reply.code(404).send("Unknown calendar event.");
      }
      return reply
        .header("DAV", "1, calendar-access")
        .header("ETag", eventEtag(event))
        .code(existing === null ? 201 : 204)
        .send();
    },
  });
}

async function authenticateDav(
  request: FastifyRequest,
  store: CalendarStore,
  requiredScope: "calendar.read" | "calendar.write",
): Promise<Actor | null> {
  const credentials = parseBasicAuthorization(request.headers.authorization);
  if (credentials === null) {
    return null;
  }
  return store.authenticateAppPassword({
    username: credentials.username,
    password: credentials.password,
    requiredScope,
  });
}

function requiredDavScope(method: string): "calendar.read" | "calendar.write" {
  return method === "PUT" || method === "DELETE" ? "calendar.write" : "calendar.read";
}

function parseBasicAuthorization(
  authorization: string | undefined,
): { readonly username: string; readonly password: string } | null {
  if (authorization === undefined) {
    return null;
  }
  const [scheme, value] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "basic" || value === undefined) {
    return null;
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function propfindDepth(value: string | undefined): 0 | 1 {
  return value?.trim() === "0" ? 0 : 1;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bodyToString(body: unknown): string {
  return typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "";
}

function davPreconditionFailure(
  request: FastifyRequest,
  existing: CalendarEventRecord | null,
): string | null {
  const ifNoneMatch = headerString(request.headers["if-none-match"]);
  if (ifNoneMatch?.trim() === "*" && existing !== null) {
    return "CalDAV resource already exists.";
  }
  const ifMatch = headerString(request.headers["if-match"]);
  if (ifMatch === undefined) {
    return null;
  }
  const candidates = ifMatch
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (existing === null) {
    return "CalDAV resource does not exist.";
  }
  if (candidates.includes("*") || candidates.includes(eventEtag(existing))) {
    return null;
  }
  return "CalDAV ETag precondition failed.";
}

function eventEtag(event: CalendarEventRecord): string {
  return `"${event.id}-${String(event.icsSequence)}"`;
}

async function sendRsvpReply(
  options: RegisterCalendarRoutesOptions,
  event: CalendarEventRecord,
  attendee: CalendarAttendeeRecord | null,
): Promise<void> {
  if (attendee === null || options.invitationSender?.sendReply === undefined) {
    return;
  }
  const actorId = attendee.actorId ?? event.organizerActorId;
  if (typeof actorId !== "string") {
    return;
  }
  await options.invitationSender.sendReply({
    orgId: event.orgId,
    actorId,
    event,
    attendee,
  });
}

function attendeeForRsvpToken(
  event: CalendarEventRecord,
  token: string,
): CalendarAttendeeRecord | null {
  return event.attendees.find((attendee) => attendee.rsvpToken === token) ?? null;
}

function parseDavEventTarget(
  url: string,
): { readonly calendarId: string; readonly eventId: string } | null {
  const path = url.split("?")[0] ?? url;
  const parts = path.split("/").filter(Boolean);
  const calendarId = parts.at(-2);
  const filename = parts.at(-1);
  if (calendarId === undefined || filename === undefined || !filename.endsWith(".ics")) {
    return null;
  }
  const eventId = filename.slice(0, -4);
  if (!isUuid(calendarId) || !isUuid(eventId)) {
    return null;
  }
  return { calendarId, eventId };
}

function parseDavCalendarCollectionTarget(url: string): string | undefined {
  const path = url.split("?")[0] ?? url;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "dav" || parts[1] !== "cal") {
    return undefined;
  }
  const last = parts.at(-1);
  if (last === undefined || last.endsWith(".ics")) {
    return undefined;
  }
  return last;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function davCalendarQueryFilter(
  actor: Actor,
  calendarId: string | undefined,
): string | undefined {
  return calendarId === actor.id ? undefined : calendarId;
}

function davCalendarWriteTarget(actor: Actor, calendarId: string): string | null {
  return calendarId === actor.id ? null : calendarId;
}

function parseCalendarQueryTimeRange(body: unknown): {
  readonly startsAt?: Date | undefined;
  readonly endsAt?: Date | undefined;
} {
  const text = bodyToString(body);
  const match = /<[^>:\s]*:?\s*time-range\b(?<attributes>[^>]*)\/?>/iu.exec(text);
  const attributes = match?.groups?.attributes;
  if (attributes === undefined) {
    return {};
  }
  return {
    ...dateAttribute("start", attributes, "startsAt"),
    ...dateAttribute("end", attributes, "endsAt"),
  };
}

function dateAttribute<K extends "startsAt" | "endsAt">(
  name: "start" | "end",
  attributes: string,
  outputKey: K,
): { readonly [P in K]?: Date } {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(attributes);
  const parsed = match?.[1] === undefined ? null : parseCaldavDate(match[1]);
  return parsed === null ? {} : ({ [outputKey]: parsed } as { readonly [P in K]?: Date });
}

function parseCaldavDate(value: string): Date | null {
  const normalized = value.trim();
  const basicUtc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(normalized);
  if (basicUtc !== null) {
    return validDate(
      new Date(
        Date.UTC(
          Number(basicUtc[1]),
          Number(basicUtc[2]) - 1,
          Number(basicUtc[3]),
          Number(basicUtc[4]),
          Number(basicUtc[5]),
          Number(basicUtc[6]),
        ),
      ),
    );
  }

  const basicDate = /^(\d{4})(\d{2})(\d{2})$/u.exec(normalized);
  if (basicDate !== null) {
    return dateFromBasicDateParts(basicDate);
  }

  return validDate(new Date(normalized));
}

function dateFromBasicDateParts(match: RegExpExecArray): Date | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function validDate(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

function propfindMultistatusXml(input: {
  readonly actor: Actor;
  readonly depth: 0 | 1;
  readonly events: readonly CalendarEventRecord[];
  readonly requestUrl: string;
}): string {
  const basePath = normalizeDavCollectionHref(input.requestUrl);
  const collectionResponses = [collectionPropfindResponse(basePath, input.actor)];
  const eventResponses =
    input.depth === 0 || isPrincipalHref(basePath)
      ? []
      : input.events.map((event) =>
          eventPropfindResponse(`/dav/cal/${event.calendarId}/${event.id}.ics`, event),
        );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    ...collectionResponses,
    ...eventResponses,
    "</D:multistatus>",
  ].join("\n");
}

function collectionPropfindResponse(href: string, actor: Actor): string {
  const isPrincipal = isPrincipalHref(href);
  return [
    "  <D:response>",
    `    <D:href>${escapeXml(href)}</D:href>`,
    "    <D:propstat>",
    "      <D:prop>",
    isPrincipal
      ? "        <D:resourcetype><D:principal/></D:resourcetype>"
      : "        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>",
    `        <D:displayname>${escapeXml(actor.displayName ?? actor.email ?? "Calendar")}</D:displayname>`,
    `        <D:current-user-principal><D:href>${escapeXml(principalHref(actor))}</D:href></D:current-user-principal>`,
    `        <C:calendar-home-set><D:href>${escapeXml(calendarHomeHref(actor))}</D:href></C:calendar-home-set>`,
    '        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
    "        <D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report></D:supported-report-set>",
    "      </D:prop>",
    "      <D:status>HTTP/1.1 200 OK</D:status>",
    "    </D:propstat>",
    "  </D:response>",
  ].join("\n");
}

function eventPropfindResponse(href: string, event: CalendarEventRecord): string {
  return [
    [
      "  <D:response>",
      `    <D:href>${escapeXml(href)}</D:href>`,
      "    <D:propstat>",
      "      <D:prop>",
      "        <D:getcontenttype>text/calendar</D:getcontenttype>",
      `        <D:getetag>${escapeXml(`"${event.id}-${String(event.icsSequence)}"`)}</D:getetag>`,
      "      </D:prop>",
      "      <D:status>HTTP/1.1 200 OK</D:status>",
      "    </D:propstat>",
      "  </D:response>",
    ].join("\n"),
  ].join("\n");
}

function normalizeDavCollectionHref(url: string): string {
  const path = url.split("?")[0] ?? url;
  const normalized = path.length === 0 ? "/dav/cal/" : path;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function principalHref(actor: Actor): string {
  return `/dav/cal/principals/${encodeURIComponent(actor.id)}/`;
}

function calendarHomeHref(actor: Actor): string {
  return `/dav/cal/${encodeURIComponent(actor.id)}/`;
}

function isPrincipalHref(href: string): boolean {
  return href.startsWith("/dav/cal/principals/");
}

function calendarQueryMultistatusXml(events: readonly CalendarEventRecord[]): string {
  const responses = events.map((event) =>
    calendarDataResponse(`/dav/cal/${event.calendarId}/${event.id}.ics`, event),
  );
  return calendarMultistatusXml(responses);
}

function calendarMultigetMultistatusXml(
  entries: readonly {
    readonly href: string;
    readonly event: CalendarEventRecord | null;
  }[],
): string {
  return calendarMultistatusXml(
    entries.map((entry) =>
      entry.event === null
        ? missingCalendarResponse(entry.href)
        : calendarDataResponse(entry.href, entry.event),
    ),
  );
}

function calendarMultistatusXml(responses: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    ...responses,
    "</D:multistatus>",
  ].join("\n");
}

function calendarDataResponse(href: string, event: CalendarEventRecord): string {
  return [
    [
      "  <D:response>",
      `    <D:href>${escapeXml(href)}</D:href>`,
      "    <D:propstat>",
      "      <D:prop>",
      "        <D:getcontenttype>text/calendar</D:getcontenttype>",
      `        <D:getetag>${escapeXml(eventEtag(event))}</D:getetag>`,
      `        <C:calendar-data>${escapeXml(createIcsCalendar({ event }))}</C:calendar-data>`,
      "      </D:prop>",
      "      <D:status>HTTP/1.1 200 OK</D:status>",
      "    </D:propstat>",
      "  </D:response>",
    ].join("\n"),
  ].join("\n");
}

function missingCalendarResponse(href: string): string {
  return [
    "  <D:response>",
    `    <D:href>${escapeXml(href)}</D:href>`,
    "    <D:status>HTTP/1.1 404 Not Found</D:status>",
    "  </D:response>",
  ].join("\n");
}

function isCalendarMultigetReport(body: string): boolean {
  return /<[^>]*calendar-multiget[\s>]/iu.test(body);
}

async function calendarMultigetEvents(input: {
  readonly actor: Actor;
  readonly bodyText: string;
  readonly store: CalendarStore;
}): Promise<readonly { readonly href: string; readonly event: CalendarEventRecord | null }[]> {
  const entries = await Promise.all(
    reportHrefs(input.bodyText).map(async (href) => {
      const target = parseDavEventTarget(href);
      const event =
        target === null
          ? null
          : await input.store.getEventForActor({
              orgId: input.actor.orgId,
              actorId: input.actor.id,
              eventId: target.eventId,
            });
      return { href, event };
    }),
  );
  return entries;
}

function reportHrefs(body: string): readonly string[] {
  return [...body.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/giu)].map((match) =>
    xmlUnescape(match[1] ?? ""),
  );
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function eventsMatchingCalendarQuery(
  events: readonly CalendarEventRecord[],
  timeRange: { readonly startsAt?: Date | undefined; readonly endsAt?: Date | undefined },
): readonly CalendarEventRecord[] {
  if (timeRange.startsAt === undefined || timeRange.endsAt === undefined) {
    return events;
  }
  return events.filter(
    (event) =>
      expandCalendarEventOccurrences(
        event,
        timeRange.startsAt ?? event.startsAt,
        timeRange.endsAt ?? event.endsAt,
      ).length > 0,
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface ParsedVevent {
  readonly uid: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly allDay: boolean;
  readonly recurrenceRule: string | null;
  readonly metadata: JsonObject;
  readonly attendees: readonly CalendarAttendeeInput[];
}

interface IcsProperty {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

function parseVeventIcs(body: unknown): ParsedVevent | null {
  const text =
    typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : null;
  if (text === null) {
    return null;
  }
  const vevents = readVeventsProperties(text);
  if (vevents.length === 0) {
    return null;
  }
  const master = vevents.find((properties) => property(properties, "RECURRENCE-ID") === undefined);
  const properties = master ?? vevents[0];
  if (properties === undefined) {
    return null;
  }
  const uid = textValue(property(properties, "UID"));
  const summary = textValue(property(properties, "SUMMARY"));
  const dtstart = property(properties, "DTSTART");
  const dtend = property(properties, "DTEND");
  if (uid === null || summary === null || dtstart === undefined || dtend === undefined) {
    return null;
  }
  const startsAt = parseIcsDate(dtstart);
  const endsAt = parseIcsDate(dtend);
  if (startsAt === null || endsAt === null || endsAt.date.getTime() <= startsAt.date.getTime()) {
    return null;
  }
  const timezone = startsAt.timezone ?? endsAt.timezone ?? "UTC";
  const exdates = uniqueStrings([
    ...properties
      .filter((candidate) => candidate.name === "EXDATE")
      .flatMap(parseIcsDateList)
      .map((date) => date.toISOString()),
    ...cancelledRecurrenceIds(vevents),
  ]);
  return {
    uid,
    title: summary,
    description: textValue(property(properties, "DESCRIPTION")),
    location: textValue(property(properties, "LOCATION")),
    startsAt: startsAt.date,
    endsAt: endsAt.date,
    timezone,
    allDay: startsAt.allDay && endsAt.allDay,
    recurrenceRule: property(properties, "RRULE")?.value ?? null,
    metadata: {
      source: "caldav.put",
      caldav: {
        exdate: exdates,
      },
    },
    attendees: properties
      .filter((candidate) => candidate.name === "ATTENDEE")
      .flatMap(parseAttendee),
  };
}

function readVeventsProperties(text: string): readonly (readonly IcsProperty[])[] {
  const lines = unfoldIcsLines(text);
  const vevents: IcsProperty[][] = [];
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.toUpperCase();
    if (line === "BEGIN:VEVENT") {
      start = index;
      continue;
    }
    if (line === "END:VEVENT" && start >= 0) {
      vevents.push(lines.slice(start + 1, index).flatMap(parseIcsProperty));
      start = -1;
    }
  }
  return vevents;
}

function unfoldIcsLines(text: string): readonly string[] {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if (/^[ \t]/u.test(line) && lines.length > 0) {
      const previous = lines[lines.length - 1] ?? "";
      lines[lines.length - 1] = previous + line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function parseIcsProperty(line: string): readonly IcsProperty[] {
  const separator = line.indexOf(":");
  if (separator < 1) {
    return [];
  }
  const head = line.slice(0, separator);
  const [namePart, ...paramParts] = head.split(";");
  if (namePart === undefined) {
    return [];
  }
  const params = new Map<string, string>();
  for (const part of paramParts) {
    const equals = part.indexOf("=");
    if (equals < 1) {
      continue;
    }
    params.set(part.slice(0, equals).toUpperCase(), unquoteIcsParam(part.slice(equals + 1)));
  }
  return [
    {
      name: namePart.toUpperCase(),
      params,
      value: line.slice(separator + 1),
    },
  ];
}

function property(properties: readonly IcsProperty[], name: string): IcsProperty | undefined {
  return properties.find((candidate) => candidate.name === name);
}

function textValue(candidate: IcsProperty | undefined): string | null {
  return candidate === undefined ? null : unescapeIcsText(candidate.value);
}

function parseIcsDate(
  propertyValue: IcsProperty,
): { readonly date: Date; readonly allDay: boolean; readonly timezone?: string } | null {
  const value = propertyValue.value;
  if (propertyValue.params.get("VALUE")?.toUpperCase() === "DATE" || /^\d{8}$/u.test(value)) {
    const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
    const date = match === null ? null : dateFromBasicDateParts(match);
    return date === null ? null : { date, allDay: true, timezone: "UTC" };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(value);
  if (match === null) {
    return null;
  }
  const year = match[1] ?? "";
  const month = match[2] ?? "";
  const day = match[3] ?? "";
  const hour = match[4] ?? "";
  const minute = match[5] ?? "";
  const second = match[6] ?? "";
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const floatingUtcDate = new Date(iso);
  const timezone = propertyValue.params.get("TZID") ?? "UTC";
  const date =
    match[7] === "Z" || timezone === "UTC"
      ? floatingUtcDate
      : zonedLocalDateToUtc(
          {
            year: Number(year),
            month: Number(month),
            day: Number(day),
            hour: Number(hour),
            minute: Number(minute),
            second: Number(second),
          },
          timezone,
        );
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    date,
    allDay: false,
    timezone,
  };
}

function parseIcsDateList(propertyValue: IcsProperty): readonly Date[] {
  return propertyValue.value.split(",").flatMap((value) => {
    const parsed = parseIcsDate({ ...propertyValue, value });
    return parsed === null ? [] : [parsed.date];
  });
}

function cancelledRecurrenceIds(vevents: readonly (readonly IcsProperty[])[]): readonly string[] {
  return vevents.flatMap((properties) => {
    const status = property(properties, "STATUS")?.value.toUpperCase();
    const recurrenceId = property(properties, "RECURRENCE-ID");
    if (status !== "CANCELLED" || recurrenceId === undefined) {
      return [];
    }
    const parsed = parseIcsDate(recurrenceId);
    return parsed === null ? [] : [parsed.date.toISOString()];
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function zonedLocalDateToUtc(
  input: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
  },
  timeZone: string,
): Date {
  let date = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = utcToZonedParts(date, timeZone);
    if (local === null) {
      return new Date(Number.NaN);
    }
    const wantedUtc = Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour,
      input.minute,
      input.second,
    );
    const actualUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const delta = wantedUtc - actualUtc;
    if (delta === 0) {
      return date;
    }
    date = new Date(date.getTime() + delta);
  }
  return date;
}

function utcToZonedParts(
  date: Date,
  timeZone: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} | null {
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
    }).formatToParts(date);
    const numberPart = (type: Intl.DateTimeFormatPartTypes): number | null => {
      const value = parts.find((candidate) => candidate.type === type)?.value;
      return value === undefined ? null : Number(value);
    };
    const year = numberPart("year");
    const month = numberPart("month");
    const day = numberPart("day");
    const hour = numberPart("hour");
    const minute = numberPart("minute");
    const second = numberPart("second");
    if (
      year === null ||
      month === null ||
      day === null ||
      hour === null ||
      minute === null ||
      second === null
    ) {
      return null;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    return null;
  }
}

function parseAttendee(propertyValue: IcsProperty): readonly CalendarAttendeeInput[] {
  const email = propertyValue.value.toLowerCase().startsWith("mailto:")
    ? propertyValue.value.slice("mailto:".length)
    : propertyValue.value;
  if (!email.includes("@")) {
    return [];
  }
  return [
    {
      email,
      displayName: propertyValue.params.get("CN") ?? null,
      role: attendeeRole(propertyValue.params.get("ROLE")),
      responseStatus: attendeeResponse(propertyValue.params.get("PARTSTAT")),
    },
  ];
}

function attendeeRole(value: string | undefined): CalendarAttendeeRole {
  const normalized = value?.toUpperCase();
  if (normalized === "OPT-PARTICIPANT") {
    return "optional";
  }
  if (normalized === "NON-PARTICIPANT") {
    return "resource";
  }
  return "required";
}

function attendeeResponse(value: string | undefined): CalendarResponseStatus {
  const normalized = value?.toUpperCase();
  if (normalized === "ACCEPTED") {
    return "accepted";
  }
  if (normalized === "DECLINED") {
    return "declined";
  }
  if (normalized === "TENTATIVE") {
    return "tentative";
  }
  return "needs_action";
}

function unescapeIcsText(value: string): string {
  return value.replace(/\\n/giu, "\n").replace(/\\([\\;,])/gu, "$1");
}

function unquoteIcsParam(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : value;
}
