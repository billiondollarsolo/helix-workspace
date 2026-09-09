import {
  localDateTimeToFloatingInstant,
  localDateTimeToInstant,
  type CalendarTimeSemantics,
} from "@helix/contracts";
import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import ICAL from "ical.js";
import { z } from "zod";
import { DAV_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import { internalApiUrl, versionedApiPath } from "../../api/version.js";
import { createIcsCalendar, type CalendarInvitationSender } from "./ics.js";
import { expandCalendarEventOccurrences, type CalendarRecurrenceOverride } from "./recurrence.js";
import {
  DavStandardsParseError,
  davElements,
  davText,
  parseDavXml,
  parseICalendar,
} from "../dav/standards.js";
import type { CalendarAttendeeInput, CalendarStore, CalendarSyncPage } from "./store.js";
import type {
  CalendarAttendeeRecord,
  CalendarAttendeeRole,
  CalendarEventRecord,
  CalendarListEntry,
  CalendarResponseStatus,
} from "./types.js";

const rsvpParamsSchema = z.object({ token: z.string().min(1) });
const rsvpQuerySchema = z.object({
  response: z.enum(["accepted", "declined", "tentative"]),
});
const membershipParamsSchema = z.object({
  calendarId: z.string().uuid(),
  actorId: z.string().uuid().optional(),
});
const membershipBodySchema = z.object({
  actorId: z.string().uuid(),
  role: z.enum(["manager", "writer", "reader"]),
});
const eventRevisionParamsSchema = z.object({ eventId: z.string().uuid() });
const eventRevisionQuerySchema = z.object({
  beforeRevision: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const restoreRevisionBodySchema = z.object({
  revision: z.number().int().nonnegative(),
  expectedIcsSequence: z.number().int().nonnegative(),
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

  app.get("/api/calendar/events/:eventId/revisions", async (request, reply) => {
    const params = eventRevisionParamsSchema.safeParse(request.params);
    const query = eventRevisionQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "invalid_revision_query" });
    }
    const actor = await options.actorFromRequest(request);
    const revisions = await options.store.listEventRevisions({
      orgId: actor.orgId,
      actorId: actor.id,
      eventId: params.data.eventId,
      beforeRevision: query.data.beforeRevision,
      limit: query.data.limit,
    });
    return revisions === null
      ? reply.code(404).send({ error: "not_found" })
      : reply.send({ revisions });
  });

  app.post("/api/calendar/events/:eventId/revisions/restore", async (request, reply) => {
    const params = eventRevisionParamsSchema.safeParse(request.params);
    const body = restoreRevisionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_revision_restore" });
    }
    const actor = await options.actorFromRequest(request);
    const event = await options.store.restoreEventRevision({
      orgId: actor.orgId,
      actorId: actor.id,
      eventId: params.data.eventId,
      revision: body.data.revision,
      expectedIcsSequence: body.data.expectedIcsSequence,
    });
    return event === null
      ? reply.code(409).send({ error: "revision_conflict_or_not_found" })
      : reply.send(event);
  });

  app.get("/api/calendar/calendars/:calendarId/memberships", async (request, reply) => {
    const params = membershipParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_calendar" });
    const actor = await options.actorFromRequest(request);
    if (actor.scopes?.includes("calendar.manage") !== true) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const memberships = await options.store.listCalendarMemberships({
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId: params.data.calendarId,
    });
    return memberships === null ? reply.code(404).send({ error: "not_found" }) : { memberships };
  });

  app.put("/api/calendar/calendars/:calendarId/memberships", async (request, reply) => {
    const params = membershipParamsSchema.safeParse(request.params);
    const body = membershipBodySchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: "invalid_membership" });
    const actor = await options.actorFromRequest(request);
    if (actor.scopes?.includes("calendar.manage") !== true) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const membership = await options.store.setCalendarMembership({
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId: params.data.calendarId,
      memberActorId: body.data.actorId,
      role: body.data.role,
    });
    return membership === null
      ? reply.code(404).send({ error: "not_found" })
      : reply.code(200).send(membership);
  });

  app.delete("/api/calendar/calendars/:calendarId/memberships/:actorId", async (request, reply) => {
    const params = membershipParamsSchema.safeParse(request.params);
    if (!params.success || params.data.actorId === undefined) {
      return reply.code(400).send({ error: "invalid_membership" });
    }
    const actor = await options.actorFromRequest(request);
    if (actor.scopes?.includes("calendar.manage") !== true) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const removed = await options.store.removeCalendarMembership({
      orgId: actor.orgId,
      actorId: actor.id,
      calendarId: params.data.calendarId,
      memberActorId: params.data.actorId,
    });
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });

  app.get("/dav/cal/rsvp/:token", async (request, reply) => {
    const params = rsvpParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).type("text/plain").send("Malformed RSVP link.");
    }
    return reply
      .header("cache-control", "no-store")
      .header("content-security-policy", "default-src 'none'; form-action 'self'; base-uri 'none'")
      .header("referrer-policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(rsvpConfirmationPage(params.data.token));
  });

  app.post("/dav/cal/rsvp/:token", async (request, reply) => {
    const params = rsvpParamsSchema.safeParse(request.params);
    const query = rsvpQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).type("text/plain").send("Malformed RSVP response.");
    }
    const { token } = params.data;
    const { response } = query.data;
    const result = await options.store.respondToRsvpToken({
      rsvpToken: token,
      responseStatus: response,
    });
    if (result === null) {
      return reply.code(404).type("text/plain").send("Unknown RSVP link.");
    }
    await sendRsvpReply(options, result.event, result.attendee);
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
    bodyLimit: DAV_BODY_LIMIT_BYTES,
    handler: async (request, reply) => {
      const actor = await authenticateDav(request, options.store, requiredDavScope(request.method));
      if (actor === null) {
        return reply
          .header("www-authenticate", 'Basic realm="Helix CalDAV"')
          .code(401)
          .send("CalDAV app password required.");
      }
      const davBodyText = bodyToString(request.body);
      if (
        (request.method === "PROPFIND" || request.method === "REPORT") &&
        davBodyText.trim().length > 0
      ) {
        try {
          parseDavXml(davBodyText);
        } catch (error) {
          if (error instanceof DavStandardsParseError) return reply.code(400).send(error.message);
          throw error;
        }
      }

      const calendars = await options.store.listCalendarsForActor({
        orgId: actor.orgId,
        actorId: actor.id,
      });

      if (request.method === "PROPFIND") {
        const depth = propfindDepth(headerString(request.headers.depth));
        const target = davDiscoveryTarget(request.url, actor, calendars);
        if (target === null) return reply.code(404).send("Unknown CalDAV collection.");
        const events =
          target.kind === "calendar" && depth === 1
            ? await options.store.listCalendarEventsForActor({
                orgId: actor.orgId,
                actorId: actor.id,
                calendarId: target.calendar.id,
                limit: 250,
              })
            : [];
        return reply
          .code(207)
          .type("application/xml; charset=utf-8")
          .send(propfindMultistatusXml({ actor, calendars, depth, events, target }));
      }

      if (request.method === "REPORT") {
        const bodyText = davBodyText;
        const calendar = davCalendarForRequest(request.url, actor, calendars);
        if (calendar === null) return reply.code(404).send("Unknown CalDAV collection.");
        if (isSyncCollectionReport(bodyText)) {
          const token = calendarSyncTokenFromReport(bodyText);
          if (
            token === "invalid" ||
            (token !== null &&
              (token.calendarId !== calendar.id || token.version > calendar.syncVersion))
          ) {
            return reply
              .code(409)
              .type("application/xml; charset=utf-8")
              .send(invalidSyncTokenXml());
          }
          const page = await options.store.listCalendarChangesForActor({
            orgId: actor.orgId,
            actorId: actor.id,
            calendarId: calendar.id,
            afterVersion: token?.version ?? 0,
            limit: syncCollectionLimit(bodyText),
          });
          if (page === null) return reply.code(404).send("Unknown CalDAV collection.");
          return reply
            .code(207)
            .type("application/xml; charset=utf-8")
            .send(calendarSyncMultistatusXml(calendar, page, bodyText));
        }
        if (isCalendarMultigetReport(bodyText)) {
          const events = await calendarMultigetEvents({
            actor,
            bodyText,
            calendarId: calendar.id,
            store: options.store,
          });
          return reply
            .code(207)
            .type("application/xml; charset=utf-8")
            .send(calendarMultigetMultistatusXml(events));
        }
        const timeRange = parseCalendarQueryTimeRange(bodyText);
        const events = await options.store.listCalendarEventsForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          calendarId: calendar.id,
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
      const calendar =
        target === null ? null : calendars.find((candidate) => candidate.id === target.calendarId);
      if (target === null || calendar === undefined || calendar === null) {
        return reply.code(404).send("Unknown CalDAV resource.");
      }

      if (request.method === "GET") {
        const event = await options.store.getEventForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          eventId: target.eventId,
        });
        if (event === null || event.calendarId !== target.calendarId) {
          return reply.code(404).send("Unknown calendar event.");
        }
        return reply
          .header("ETag", eventEtag(event))
          .type("text/calendar; charset=utf-8")
          .send(createIcsCalendar({ event }));
      }

      if (request.method === "DELETE") {
        const found = await options.store.getEventForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          eventId: target.eventId,
        });
        const existing = found?.calendarId === target.calendarId ? found : null;
        const preconditionFailure = davPreconditionFailure(request, existing);
        if (preconditionFailure !== null) {
          return reply.code(412).send(preconditionFailure);
        }
        const deleted = await options.store.deleteEvent({
          orgId: actor.orgId,
          actorId: actor.id,
          eventId: target.eventId,
          ...expectedIcsSequence(request, existing),
        });
        return deleted === null
          ? reply
              .code(existing === null ? 404 : 412)
              .send(
                existing === null ? "Unknown calendar event." : "CalDAV ETag precondition failed.",
              )
          : reply.code(204).send();
      }

      const parsed = parseVeventIcs(request.body);
      if (parsed === null) {
        return reply.code(400).send("CalDAV PUT requires a VEVENT calendar body.");
      }

      const found = await options.store.getEventForActor({
        orgId: actor.orgId,
        actorId: actor.id,
        eventId: target.eventId,
      });
      const existing = found?.calendarId === target.calendarId ? found : null;
      const preconditionFailure = davPreconditionFailure(request, existing);
      if (preconditionFailure !== null) {
        return reply.code(412).send(preconditionFailure);
      }
      let event: CalendarEventRecord | null;
      try {
        event =
          existing === null
            ? await options.store.createEvent({
                id: target.eventId,
                orgId: actor.orgId,
                actorId: actor.id,
                calendarId: target.calendarId,
                uid: parsed.uid,
                title: parsed.title,
                description: parsed.description,
                location: parsed.location,
                startsAt: parsed.startsAt,
                endsAt: parsed.endsAt,
                timezone: parsed.timezone,
                allDay: parsed.allDay,
                timeSemantics: parsed.timeSemantics,
                recurrenceRule: parsed.recurrenceRule,
                attendees: parsed.attendees,
                metadata: parsed.metadata,
              })
            : await options.store.updateEvent({
                orgId: actor.orgId,
                actorId: actor.id,
                eventId: target.eventId,
                ...expectedIcsSequence(request, existing),
                patch: {
                  title: parsed.title,
                  description: parsed.description,
                  location: parsed.location,
                  startsAt: parsed.startsAt,
                  endsAt: parsed.endsAt,
                  timezone: parsed.timezone,
                  allDay: parsed.allDay,
                  timeSemantics: parsed.timeSemantics,
                  recurrenceRule: parsed.recurrenceRule,
                  attendees: parsed.attendees,
                  metadata: parsed.metadata,
                },
              });
      } catch (error) {
        if (
          existing === null &&
          headerString(request.headers["if-none-match"])?.trim() === "*" &&
          isUniqueViolation(error)
        ) {
          return reply.code(412).send("CalDAV resource already exists.");
        }
        throw error;
      }

      if (event === null) {
        return reply
          .code(existing === null ? 404 : 412)
          .send(existing === null ? "Unknown calendar event." : "CalDAV ETag precondition failed.");
      }
      return reply
        .header("DAV", "1, calendar-access")
        .header("ETag", eventEtag(event))
        .code(existing === null ? 201 : 204)
        .send();
    },
  });
}

function rsvpConfirmationPage(token: string): string {
  const path = versionedApiPath(`/dav/cal/rsvp/${encodeURIComponent(token)}`);
  const button = (response: CalendarResponseStatus, label: string) =>
    `<button type="submit" formaction="${path}?response=${response}">${label}</button>`;
  return [
    "<!doctype html>",
    '<html lang="en"><meta charset="utf-8"><title>Respond to invitation</title>',
    "<body><main><h1>Respond to invitation</h1><p>Choose a response to update the event.</p>",
    '<form method="post">',
    button("accepted", "Accept"),
    button("tentative", "Maybe"),
    button("declined", "Decline"),
    "</form></main></body></html>",
  ].join("");
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
  const excludedEtags = etagCandidates(ifNoneMatch);
  if (
    existing !== null &&
    (excludedEtags.includes("*") || excludedEtags.includes(eventEtag(existing)))
  ) {
    return "CalDAV resource already exists.";
  }
  const ifMatch = headerString(request.headers["if-match"]);
  if (ifMatch === undefined) {
    return null;
  }
  const candidates = etagCandidates(ifMatch);
  if (existing === null) {
    return "CalDAV resource does not exist.";
  }
  if (candidates.includes("*") || candidates.includes(eventEtag(existing))) {
    return null;
  }
  return "CalDAV ETag precondition failed.";
}

function etagCandidates(header: string | undefined): readonly string[] {
  return (header ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function expectedIcsSequence(
  request: FastifyRequest,
  existing: CalendarEventRecord | null,
): { readonly expectedIcsSequence?: number | undefined } {
  if (
    existing !== null &&
    etagCandidates(headerString(request.headers["if-match"])).includes(eventEtag(existing))
  ) {
    return { expectedIcsSequence: existing.icsSequence };
  }
  return {};
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
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

function parseDavEventTarget(
  url: string,
): { readonly calendarId: string; readonly eventId: string } | null {
  const path = internalApiUrl(url.split("?")[0] ?? url);
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
  const path = internalApiUrl(url.split("?")[0] ?? url);
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

type DavDiscoveryTarget =
  | { readonly kind: "root" }
  | { readonly kind: "principal" }
  | { readonly kind: "home" }
  | { readonly kind: "calendar"; readonly calendar: CalendarListEntry };

function davDiscoveryTarget(
  url: string,
  actor: Actor,
  calendars: readonly CalendarListEntry[],
): DavDiscoveryTarget | null {
  const href = normalizeDavCollectionHref(url);
  if (href === versionedApiPath("/dav/cal/")) return { kind: "root" };
  if (href === principalHref(actor)) return { kind: "principal" };
  if (href.startsWith(versionedApiPath("/dav/cal/principals/"))) return null;
  if (href === calendarHomeHref(actor)) return { kind: "home" };
  const calendarId = parseDavCalendarCollectionTarget(href);
  const calendar = calendars.find((candidate) => candidate.id === calendarId);
  return calendar === undefined ? null : { kind: "calendar", calendar };
}

function davCalendarForRequest(
  url: string,
  actor: Actor,
  calendars: readonly CalendarListEntry[],
): CalendarListEntry | null {
  const target = davDiscoveryTarget(url, actor, calendars);
  return target?.kind === "calendar" ? target.calendar : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseCalendarQueryTimeRange(body: unknown): {
  readonly startsAt?: Date | undefined;
  readonly endsAt?: Date | undefined;
} {
  const text = bodyToString(body);
  const element = davElements(parseDavXml(text), "time-range")[0];
  if (element === undefined) return {};
  return {
    ...dateAttribute(element.attributes.start, "startsAt"),
    ...dateAttribute(element.attributes.end, "endsAt"),
  };
}

function dateAttribute<K extends "startsAt" | "endsAt">(
  value: string | undefined,
  outputKey: K,
): { readonly [P in K]?: Date } {
  const parsed = value === undefined ? null : parseCaldavDate(value);
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
  readonly calendars: readonly CalendarListEntry[];
  readonly depth: 0 | 1;
  readonly events: readonly CalendarEventRecord[];
  readonly target: DavDiscoveryTarget;
}): string {
  const collectionResponses = [collectionPropfindResponse(input.target, input.actor)];
  if (input.depth === 1 && input.target.kind === "home") {
    collectionResponses.push(
      ...input.calendars.map((calendar) =>
        collectionPropfindResponse({ kind: "calendar", calendar }, input.actor),
      ),
    );
  }
  const eventResponses =
    input.depth === 1 && input.target.kind === "calendar"
      ? input.events.map((event) =>
          eventPropfindResponse(
            versionedApiPath(`/dav/cal/${event.calendarId}/${event.id}.ics`),
            event,
          ),
        )
      : [];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">',
    ...collectionResponses,
    ...eventResponses,
    "</D:multistatus>",
  ].join("\n");
}

function collectionPropfindResponse(target: DavDiscoveryTarget, actor: Actor): string {
  const calendar = target.kind === "calendar" ? target.calendar : null;
  const href =
    target.kind === "root"
      ? versionedApiPath("/dav/cal/")
      : target.kind === "principal"
        ? principalHref(actor)
        : target.kind === "home"
          ? calendarHomeHref(actor)
          : calendarHref(target.calendar.id);
  const resourceType =
    target.kind === "principal"
      ? "<D:principal/>"
      : target.kind === "calendar"
        ? "<D:collection/><C:calendar/>"
        : "<D:collection/>";
  const calendarProperties =
    calendar === null
      ? []
      : [
          `        <D:getetag>${escapeXml(calendarCollectionEtag(calendar))}</D:getetag>`,
          `        <CS:getctag>${escapeXml(calendarCollectionEtag(calendar))}</CS:getctag>`,
          `        <D:sync-token>${escapeXml(calendarSyncToken(calendar.id, calendar.syncVersion))}</D:sync-token>`,
          '        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
          "        <D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>",
          currentUserPrivilegeSet(calendar),
        ];
  return [
    "  <D:response>",
    `    <D:href>${escapeXml(href)}</D:href>`,
    "    <D:propstat>",
    "      <D:prop>",
    `        <D:resourcetype>${resourceType}</D:resourcetype>`,
    `        <D:displayname>${escapeXml(calendar?.name ?? actor.displayName ?? actor.email ?? "Calendar")}</D:displayname>`,
    `        <D:current-user-principal><D:href>${escapeXml(principalHref(actor))}</D:href></D:current-user-principal>`,
    `        <C:calendar-home-set><D:href>${escapeXml(calendarHomeHref(actor))}</D:href></C:calendar-home-set>`,
    ...calendarProperties,
    "      </D:prop>",
    "      <D:status>HTTP/1.1 200 OK</D:status>",
    "    </D:propstat>",
    "  </D:response>",
  ].join("\n");
}

function currentUserPrivilegeSet(calendar: CalendarListEntry): string {
  const writePrivileges = calendar.writable
    ? "<D:privilege><D:write-content/></D:privilege><D:privilege><D:write-properties/></D:privilege>"
    : "";
  return `        <D:current-user-privilege-set><D:privilege><D:read/></D:privilege>${writePrivileges}</D:current-user-privilege-set>`;
}

function calendarHref(calendarId: string): string {
  return versionedApiPath(`/dav/cal/${encodeURIComponent(calendarId)}/`);
}

function calendarCollectionEtag(calendar: CalendarListEntry): string {
  return `"calendar-${calendar.id}-${String(calendar.syncVersion)}"`;
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
  const normalized = versionedApiPath(path.length === 0 ? "/dav/cal/" : path);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function principalHref(actor: Actor): string {
  return versionedApiPath(`/dav/cal/principals/${encodeURIComponent(actor.id)}/`);
}

function calendarHomeHref(actor: Actor): string {
  return versionedApiPath(`/dav/cal/${encodeURIComponent(actor.id)}/`);
}

function calendarQueryMultistatusXml(events: readonly CalendarEventRecord[]): string {
  const responses = events.map((event) =>
    calendarDataResponse(versionedApiPath(`/dav/cal/${event.calendarId}/${event.id}.ics`), event),
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

function calendarMultistatusXml(responses: readonly string[], syncToken?: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    ...responses,
    ...(syncToken === undefined ? [] : [`  <D:sync-token>${escapeXml(syncToken)}</D:sync-token>`]),
    "</D:multistatus>",
  ].join("\n");
}

function calendarDataResponse(
  href: string,
  event: CalendarEventRecord,
  includeCalendarData = true,
): string {
  return [
    [
      "  <D:response>",
      `    <D:href>${escapeXml(href)}</D:href>`,
      "    <D:propstat>",
      "      <D:prop>",
      "        <D:getcontenttype>text/calendar</D:getcontenttype>",
      `        <D:getetag>${escapeXml(eventEtag(event))}</D:getetag>`,
      ...(includeCalendarData
        ? [`        <C:calendar-data>${escapeXml(createIcsCalendar({ event }))}</C:calendar-data>`]
        : []),
      "      </D:prop>",
      "      <D:status>HTTP/1.1 200 OK</D:status>",
      "    </D:propstat>",
      "  </D:response>",
    ].join("\n"),
  ].join("\n");
}

function calendarSyncMultistatusXml(
  calendar: CalendarListEntry,
  page: CalendarSyncPage,
  requestBody: string,
): string {
  const includeCalendarData = davElements(parseDavXml(requestBody), "calendar-data").length > 0;
  const responses = page.changes.map((change) =>
    change.event === null
      ? missingCalendarResponse(`${calendarHref(calendar.id)}${change.eventId}.ics`)
      : calendarDataResponse(
          `${calendarHref(calendar.id)}${change.eventId}.ics`,
          change.event,
          includeCalendarData,
        ),
  );
  if (page.hasMore) {
    responses.push(syncLimitResponse(calendarHref(calendar.id)));
  }
  return calendarMultistatusXml(responses, calendarSyncToken(calendar.id, page.version));
}

function syncLimitResponse(href: string): string {
  return [
    "  <D:response>",
    `    <D:href>${escapeXml(href)}</D:href>`,
    "    <D:status>HTTP/1.1 507 Insufficient Storage</D:status>",
    "    <D:error><D:number-of-matches-within-limits/></D:error>",
    "  </D:response>",
  ].join("\n");
}

function isSyncCollectionReport(body: string): boolean {
  return davElements(parseDavXml(body), "sync-collection").length > 0;
}

function calendarSyncTokenFromReport(
  body: string,
): { readonly calendarId: string; readonly version: number } | "invalid" | null {
  const element = davElements(parseDavXml(body), "sync-token")[0];
  const token = davText(element).trim();
  if (element === undefined || token.length === 0) return null;
  const match =
    /^data:,helix-caldav-sync-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(\d+)$/iu.exec(
      token,
    );
  const version = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  return match?.[1] === undefined || !Number.isSafeInteger(version)
    ? "invalid"
    : { calendarId: match[1], version };
}

function calendarSyncToken(calendarId: string, version: number): string {
  return `data:,helix-caldav-sync-${calendarId}-${String(version)}`;
}

function syncCollectionLimit(body: string): number {
  const value = davText(davElements(parseDavXml(body), "nresults")[0]);
  const parsed = value.length === 0 ? 250 : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 250) : 250;
}

function invalidSyncTokenXml(): string {
  return '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>';
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
  return davElements(parseDavXml(body), "calendar-multiget").length > 0;
}

async function calendarMultigetEvents(input: {
  readonly actor: Actor;
  readonly bodyText: string;
  readonly calendarId: string;
  readonly store: CalendarStore;
}): Promise<readonly { readonly href: string; readonly event: CalendarEventRecord | null }[]> {
  const entries = await Promise.all(
    reportHrefs(input.bodyText).map(async (href) => {
      const target = parseDavEventTarget(href);
      const event =
        target === null || target.calendarId !== input.calendarId
          ? null
          : await input.store.getEventForActor({
              orgId: input.actor.orgId,
              actorId: input.actor.id,
              eventId: target.eventId,
            });
      return {
        href,
        event: event?.calendarId === input.calendarId ? event : null,
      };
    }),
  );
  return entries;
}

function reportHrefs(body: string): readonly string[] {
  return davElements(parseDavXml(body), "href").map((element) => davText(element));
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
  readonly timeSemantics: CalendarTimeSemantics;
  readonly recurrenceRule: string | null;
  readonly metadata: JsonObject;
  readonly attendees: readonly CalendarAttendeeInput[];
}

function parseVeventIcs(body: unknown): ParsedVevent | null {
  const text =
    typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : null;
  if (text === null) {
    return null;
  }
  let calendar: InstanceType<typeof ICAL.Component>;
  try {
    calendar = parseICalendar(text);
  } catch (error) {
    if (error instanceof DavStandardsParseError) return null;
    throw error;
  }
  const vevents = calendar.getAllSubcomponents("vevent");
  const event = vevents.find((candidate) => !candidate.hasProperty("recurrence-id")) ?? vevents[0];
  if (event === undefined) return null;
  const uid = componentText(event, "uid");
  const summary = componentText(event, "summary");
  const startsAt = parseIcsDate(event.getFirstProperty("dtstart"));
  const endsAt = parseIcsDate(event.getFirstProperty("dtend"));
  if (
    uid === null ||
    summary === null ||
    startsAt === null ||
    endsAt === null ||
    endsAt.date.getTime() <= startsAt.date.getTime()
  ) {
    return null;
  }
  const timezone = startsAt.timezone ?? endsAt.timezone ?? "UTC";
  const overrideComponents = vevents.filter((candidate) => candidate.hasProperty("recurrence-id"));
  if (overrideComponents.length > 1_000) return null;
  const overrides = overrideComponents.map((candidate) =>
    parseRecurrenceOverride(candidate, event, uid, startsAt.date, endsAt.date),
  );
  if (overrides.some((candidate) => candidate === null)) return null;
  const exdates = uniqueStrings([
    ...event
      .getAllProperties("exdate")
      .flatMap((candidate) =>
        candidate.getValues().flatMap((value) => parseIcsTime(value, candidate)),
      )
      .map((date) => date.toISOString()),
    ...cancelledRecurrenceIds(vevents),
  ]);
  return {
    uid,
    title: summary,
    description: componentText(event, "description"),
    location: componentText(event, "location"),
    startsAt: startsAt.date,
    endsAt: endsAt.date,
    timezone,
    allDay: startsAt.allDay && endsAt.allDay,
    timeSemantics: startsAt.timeSemantics,
    recurrenceRule: componentValueText(event, "rrule"),
    metadata: {
      source: "caldav.put",
      caldav: {
        exdate: exdates,
        overrides: overrides.flatMap((override) =>
          override === null ? [] : [calendarOverrideJson(override)],
        ),
      },
    },
    attendees: event.getAllProperties("attendee").flatMap(parseAttendee),
  };
}

function calendarOverrideJson(override: CalendarRecurrenceOverride): JsonObject {
  return {
    recurrenceId: override.recurrenceId,
    range: override.range,
    startsAt: override.startsAt,
    endsAt: override.endsAt,
    status: override.status,
    sequence: override.sequence,
    dtstamp: override.dtstamp,
    attendees: override.attendees.map((attendee) => ({
      email: attendee.email,
      responseStatus: attendee.responseStatus,
      ...(attendee.displayName === undefined ? {} : { displayName: attendee.displayName }),
      ...(attendee.role === undefined ? {} : { role: attendee.role }),
    })),
    ...(override.title === undefined ? {} : { title: override.title }),
    ...(override.description === undefined ? {} : { description: override.description }),
    ...(override.location === undefined ? {} : { location: override.location }),
  };
}

function parseRecurrenceOverride(
  component: InstanceType<typeof ICAL.Component>,
  master: InstanceType<typeof ICAL.Component>,
  uid: string,
  masterStartsAt: Date,
  masterEndsAt: Date,
): CalendarRecurrenceOverride | null {
  if (componentText(component, "uid") !== uid) return null;
  const recurrenceProperty = component.getFirstProperty("recurrence-id");
  if (recurrenceProperty === null) return null;
  const recurrence = parseIcsDate(recurrenceProperty);
  if (recurrence === null) return null;
  const duration = masterEndsAt.getTime() - masterStartsAt.getTime();
  const parsedStart = parseIcsDate(component.getFirstProperty("dtstart"));
  const parsedEnd = parseIcsDate(component.getFirstProperty("dtend"));
  const startsAt = parsedStart?.date ?? recurrence.date;
  const endsAt = parsedEnd?.date ?? new Date(startsAt.getTime() + duration);
  if (endsAt <= startsAt) return null;
  const rawStatus = componentText(component, "status")?.toLowerCase() ?? "confirmed";
  if (rawStatus !== "confirmed" && rawStatus !== "tentative" && rawStatus !== "cancelled") {
    return null;
  }
  const rawSequence = component.getFirstPropertyValue("sequence");
  const sequence = rawSequence === null ? 0 : Number(rawSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  const dtstamp =
    parseIcsDate(component.getFirstProperty("dtstamp"))?.date ??
    parseIcsDate(master.getFirstProperty("dtstamp"))?.date ??
    new Date(0);
  const rangeValue: unknown = recurrenceProperty.getFirstParameter("range");
  const range = typeof rangeValue === "string" ? rangeValue.toUpperCase() : undefined;
  return {
    recurrenceId: recurrence.date.toISOString(),
    range: range === "THISANDFUTURE" ? "this_and_future" : "this",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: rawStatus,
    title: componentText(component, "summary") ?? componentText(master, "summary") ?? uid,
    description: componentText(component, "description"),
    location: componentText(component, "location"),
    sequence,
    dtstamp: dtstamp.toISOString(),
    attendees: component
      .getAllProperties("attendee")
      .flatMap(parseAttendee)
      .map((attendee) => ({
        email: attendee.email,
        displayName: attendee.displayName,
        role: attendee.role,
        responseStatus: attendee.responseStatus ?? "needs_action",
      })),
  };
}

function componentText(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function componentValueText(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
): string | null {
  const value = component.getFirstPropertyValue(name);
  return value === null ? null : String(value);
}

function parseIcsDate(propertyValue: InstanceType<typeof ICAL.Property> | null): {
  readonly date: Date;
  readonly allDay: boolean;
  readonly timezone?: string;
  readonly timeSemantics: CalendarTimeSemantics;
} | null {
  if (propertyValue === null) return null;
  const value = propertyValue.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  return dateFromIcalTime(value, propertyValue.getFirstParameter("tzid"));
}

function dateFromIcalTime(
  value: InstanceType<typeof ICAL.Time>,
  tzid: string | undefined,
): {
  readonly date: Date;
  readonly allDay: boolean;
  readonly timezone?: string;
  readonly timeSemantics: CalendarTimeSemantics;
} | null {
  if (value.isDate) {
    const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
    return { date, allDay: true, timezone: "UTC", timeSemantics: "all_day" };
  }
  const localDateTime = [
    `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`,
    `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}:${String(value.second).padStart(2, "0")}`,
  ].join("T");
  const isUtc = value.zone.tzid === "UTC";
  const timezone = isUtc ? "UTC" : (tzid ?? "UTC");
  const timeSemantics = isUtc || tzid !== undefined ? "zoned" : "floating";
  let date: Date;
  try {
    date =
      timeSemantics === "floating"
        ? localDateTimeToFloatingInstant(localDateTime)
        : localDateTimeToInstant(localDateTime, timezone);
  } catch {
    return null;
  }
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    date,
    allDay: false,
    timezone,
    timeSemantics,
  };
}

function parseIcsTime(
  value: unknown,
  property: InstanceType<typeof ICAL.Property>,
): readonly Date[] {
  if (!(value instanceof ICAL.Time)) return [];
  const parsed = dateFromIcalTime(value, property.getFirstParameter("tzid"));
  return parsed === null ? [] : [parsed.date];
}

function cancelledRecurrenceIds(
  vevents: readonly InstanceType<typeof ICAL.Component>[],
): readonly string[] {
  return vevents.flatMap((event) => {
    if (componentText(event, "status")?.toUpperCase() !== "CANCELLED") return [];
    const parsed = parseIcsDate(event.getFirstProperty("recurrence-id"));
    return parsed === null ? [] : [parsed.date.toISOString()];
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function parseAttendee(
  propertyValue: InstanceType<typeof ICAL.Property>,
): readonly CalendarAttendeeInput[] {
  const raw = propertyValue.getFirstValue();
  if (typeof raw !== "string") return [];
  const email = raw.toLowerCase().startsWith("mailto:") ? raw.slice("mailto:".length) : raw;
  if (!email.includes("@")) {
    return [];
  }
  return [
    {
      email,
      displayName: optionalParameter(propertyValue, "cn") ?? null,
      role: attendeeRole(propertyValue.getFirstParameter("role")),
      responseStatus: attendeeResponse(propertyValue.getFirstParameter("partstat")),
    },
  ];
}

function optionalParameter(
  propertyValue: InstanceType<typeof ICAL.Property>,
  name: string,
): string | undefined {
  const value: unknown = propertyValue.getFirstParameter(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
