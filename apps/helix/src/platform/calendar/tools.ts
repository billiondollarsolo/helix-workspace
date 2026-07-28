import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { findCalendarMeetingTimes } from "./freebusy.js";
import type { CalendarInvitationSender } from "./ics.js";
import type {
  CalendarAttendeeRecord,
  CalendarEventRecord,
  CalendarFreeBusyStore,
  CalendarListEntry,
} from "./types.js";
import type { CalendarAttendeeInput, CalendarStore } from "./store.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});
const responseStatusSchema = z.enum(["needs_action", "accepted", "declined", "tentative"]);
const attendeeSchema = z.object({
  actorId: uuidSchema.nullable().optional(),
  email: z.string().email(),
  displayName: z.string().min(1).nullable().optional(),
  role: z.enum(["required", "optional", "resource"]).default("required"),
  responseStatus: responseStatusSchema.default("needs_action"),
  metadata: metadataSchema,
});

const createSchema = z.object({
  calendarId: uuidSchema.nullable().optional(),
  title: z.string().min(1).max(512),
  description: z.string().max(100_000).nullable().optional(),
  location: z.string().max(2048).nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().min(1).default("UTC"),
  allDay: z.boolean().default(false),
  recurrenceRule: z.string().min(1).nullable().optional(),
  attendees: z.array(attendeeSchema).default([]),
  metadata: metadataSchema,
  sendInvitations: z.boolean().default(true),
});

const updatePatchSchema = createSchema
  .omit({ sendInvitations: true })
  .partial()
  .extend({
    visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
  });

const updateSchema = updatePatchSchema.extend({
  eventId: uuidSchema,
  patch: updatePatchSchema.optional(),
  sendInvitations: z.boolean().default(true),
});

const deleteSchema = z.object({
  eventId: uuidSchema,
  sendCancellation: z.boolean().default(true),
});

const respondSchema = z.object({
  eventId: uuidSchema.optional(),
  attendeeEmail: z.string().email().optional(),
  rsvpToken: z.string().min(1).optional(),
  responseStatus: z.enum(["accepted", "declined", "tentative"]),
});

const listSchema = z.object({
  calendarId: uuidSchema.nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  limit: z.number().int().positive().max(250).default(100),
});

const findTimeSchema = z.object({
  attendeeActorIds: z.array(uuidSchema).default([]),
  attendeeEmails: z.array(z.string().email()).default([]),
  windowStartsAt: z.string().datetime(),
  windowEndsAt: z.string().datetime(),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60),
  stepMinutes: z.number().int().positive().max(240).default(15),
  limit: z.number().int().positive().max(100).default(10),
});

const calendarsListSchema = z.object({});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateCalendarToolDefinitionsOptions {
  readonly store: CalendarStore;
  readonly invitationSender?: CalendarInvitationSender | undefined;
  readonly rsvpBaseUrl?: string | undefined;
  /**
   * Domains considered internal to the organization. A create/update call that
   * invites an attendee outside these domains additionally requires the
   * `calendar.external` composite scope (PRD §9.4). When omitted, external-
   * attendee enforcement is disabled (no internal domain is known).
   */
  readonly internalDomains?: readonly string[];
}

/** Lower-cased domain portion of an email address, or "" when unparseable. */
function calendarAddressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * True when any attendee of a create/update call addresses a domain outside the
 * configured internal-domain set. Gates the `calendar.external` scope.
 */
function hasExternalAttendee(
  input: { readonly attendees?: unknown },
  internalDomains: ReadonlySet<string>,
): boolean {
  if (internalDomains.size === 0 || !Array.isArray(input.attendees)) {
    return false;
  }
  return input.attendees.some((entry) => {
    if (entry === null || typeof entry !== "object" || !("email" in entry)) {
      return false;
    }
    const email = (entry as { email?: unknown }).email;
    if (typeof email !== "string" || email.length === 0) {
      return false;
    }
    const domain = calendarAddressDomain(email);
    return domain.length > 0 && !internalDomains.has(domain);
  });
}

export function createCalendarToolDefinitions(
  options: CreateCalendarToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const internalDomains = new Set(
    (options.internalDomains ?? []).map((domain) => domain.toLowerCase()),
  );
  const externalAttendeeScope = {
    scope: "calendar.external",
    reason:
      "Inviting an attendee outside the organization's domains requires the calendar.external scope.",
    when: (input: { attendees?: unknown }) => hasExternalAttendee(input, internalDomains),
  };

  return [
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "calendar.event.create",
      description: "Create a calendar event.",
      permission: "calendar.write",
      sideEffects: "external_communication",
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalAttendeeScope] },
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const event = await options.store.createEvent({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          calendarId: input.calendarId ?? null,
          title: input.title,
          description: input.description ?? null,
          location: input.location ?? null,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          timezone: input.timezone,
          allDay: input.allDay,
          recurrenceRule: input.recurrenceRule ?? null,
          attendees: attendeeInputs(input.attendees),
          metadata: toJsonObject(input.metadata),
        });
        const invitationsQueued = input.sendInvitations
          ? await sendInvitations(options, ctx.actor.id, event, "REQUEST")
          : 0;
        return { ...serializeEvent(event), invitationsQueued };
      },
    }),
    defineTool<z.output<typeof updateSchema>, unknown>({
      id: "calendar.event.update",
      description: "Update a calendar event.",
      permission: "calendar.write",
      sideEffects: "external_communication",
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalAttendeeScope] },
      inputSchema: zodToolSchema(updateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (
        { eventId, sendInvitations: shouldSend, patch: nestedPatch, ...topLevelPatch },
        ctx,
      ) => {
        const patch = { ...topLevelPatch, ...(nestedPatch ?? {}) };
        const event = await options.store.updateEvent({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          eventId,
          patch: updatePatchFromInput(patch),
        });
        if (event === null) {
          throw new Error(`Unknown calendar event: ${eventId}`);
        }
        const invitationsQueued = shouldSend
          ? await sendInvitations(options, ctx.actor.id, event, "REQUEST")
          : 0;
        return { ...serializeEvent(event), invitationsQueued };
      },
    }),
    defineTool<z.output<typeof deleteSchema>, unknown>({
      id: "calendar.event.delete",
      description: "Cancel and delete a calendar event.",
      permission: "calendar.write",
      sideEffects: "external_communication",
      confirmationRequired: true,
      inputSchema: zodToolSchema(deleteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const event = (await options.store.deleteEvent({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          eventId: input.eventId,
        })) as unknown as CalendarEventRecord | null | boolean;
        if (event === null || event === false) {
          throw new Error(`Unknown calendar event: ${input.eventId}`);
        }
        const cancellationsQueued =
          input.sendCancellation && event !== true
            ? await sendInvitations(options, ctx.actor.id, event, "CANCEL")
            : 0;
        return { deleted: true, eventId: input.eventId, cancellationsQueued };
      },
    }),
    defineTool<z.output<typeof respondSchema>, unknown>({
      id: "calendar.event.respond",
      description: "Respond to a calendar invitation.",
      permission: "calendar.write:respond",
      sideEffects: "external_communication",
      inputSchema: zodToolSchema(respondSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const event = await options.store.respondToEvent({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          eventId: input.eventId,
          attendeeEmail: input.attendeeEmail,
          rsvpToken: input.rsvpToken,
          responseStatus: input.responseStatus,
        });
        if (event === null) {
          throw new Error("Unknown calendar invitation response target.");
        }
        const rsvpRepliesQueued = await sendReply(
          options,
          ctx.actor.id,
          event,
          replyAttendeeFromInput(event, input),
        );
        return { ...serializeEvent(event), rsvpRepliesQueued };
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "calendar.event.list",
      description: "List calendar events visible to the current actor.",
      permission: "calendar.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        events: (
          await options.store.listCalendarEventsForActor({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.calendarId === undefined || input.calendarId === null
              ? {}
              : { calendarId: input.calendarId }),
            ...(input.startsAt === undefined ? {} : { startsAt: new Date(input.startsAt) }),
            ...(input.endsAt === undefined ? {} : { endsAt: new Date(input.endsAt) }),
            limit: input.limit,
          })
        ).map(serializeEvent),
      }),
    }),
    defineTool<z.output<typeof calendarsListSchema>, unknown>({
      id: "calendar.calendars.list",
      description:
        "List the calendars visible to the current actor — calendars they own (My calendars) and calendars they are a member of (Team) — with colour and visibility.",
      permission: "calendar.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(calendarsListSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        const calendars = (
          await options.store.listCalendarsForActor({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
          })
        ).map(serializeCalendarEntry);
        return {
          calendars,
          mine: calendars.filter((calendar) => calendar.group === "mine"),
          team: calendars.filter((calendar) => calendar.group === "team"),
        };
      },
    }),
    defineTool<z.output<typeof findTimeSchema>, unknown>({
      id: "calendar.find-time",
      description: "Find free meeting slots for calendar attendees.",
      permission: "calendar.read:freebusy",
      sideEffects: "read",
      inputSchema: zodToolSchema(findTimeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (typeof options.store.findTime === "function") {
          return {
            slots: (
              await options.store.findTime({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                attendeeActorIds: input.attendeeActorIds,
                attendeeEmails: input.attendeeEmails,
                windowStartsAt: new Date(input.windowStartsAt),
                windowEndsAt: new Date(input.windowEndsAt),
                durationMinutes: input.durationMinutes,
                stepMinutes: input.stepMinutes,
                limit: input.limit,
              })
            ).map((slot) => ({
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              busy: slot.busy.map((busy) => ({
                ...busy,
                startsAt: busy.startsAt.toISOString(),
                endsAt: busy.endsAt.toISOString(),
              })),
            })),
          };
        }
        if (hasFreeBusyStore(options.store)) {
          const result = await findCalendarMeetingTimes(options.store, {
            orgId: ctx.actor.orgId,
            actorIds: [ctx.actor.id, ...input.attendeeActorIds],
            startsAt: new Date(input.windowStartsAt),
            endsAt: new Date(input.windowEndsAt),
            durationMinutes: input.durationMinutes,
            incrementMinutes: input.stepMinutes,
            limit: input.limit,
          });
          return {
            slots: result.slots.map((slot) => ({
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              busy: [],
            })),
          };
        }
        throw new Error("Calendar store does not implement free/busy lookup.");
      },
    }),
  ];
}

async function sendReply(
  options: CreateCalendarToolDefinitionsOptions,
  actorId: string,
  event: CalendarEventRecord,
  attendee: CalendarAttendeeRecord | null,
): Promise<number> {
  if (attendee === null || options.invitationSender?.sendReply === undefined) {
    return 0;
  }
  const queued = await options.invitationSender.sendReply({
    orgId: event.orgId,
    actorId,
    event,
    attendee,
  });
  return queued.length;
}

function replyAttendeeFromInput(
  event: CalendarEventRecord,
  input: z.output<typeof respondSchema>,
): CalendarAttendeeRecord | null {
  return (
    event.attendees.find(
      (attendee) =>
        (input.rsvpToken !== undefined && attendee.rsvpToken === input.rsvpToken) ||
        (input.attendeeEmail !== undefined &&
          attendee.email.toLowerCase() === input.attendeeEmail.toLowerCase()),
    ) ?? null
  );
}

export function registerCalendarTools(
  registry: RuntimeToolRegistry,
  options: CreateCalendarToolDefinitionsOptions,
): void {
  for (const tool of createCalendarToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

async function sendInvitations(
  options: CreateCalendarToolDefinitionsOptions,
  actorId: string,
  event: CalendarEventRecord,
  method: "REQUEST" | "CANCEL",
): Promise<number> {
  const queued = await options.invitationSender?.sendInvitation({
    orgId: event.orgId,
    actorId,
    event,
    method,
    ...(options.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: options.rsvpBaseUrl }),
  });
  return queued?.length ?? 0;
}

function serializeCalendarEntry(entry: CalendarListEntry) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    timezone: entry.timezone,
    color: entry.color,
    ownerActorId: entry.ownerActorId,
    ownerDisplayName: entry.ownerDisplayName,
    role: entry.role,
    visible: entry.visible,
    group: entry.group,
    writable: entry.writable,
    sortOrder: entry.sortOrder,
    eventCount: entry.eventCount,
  };
}

function serializeEvent(event: CalendarEventRecord) {
  return {
    ...event,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    deletedAt: event.deletedAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    attendees: event.attendees.map((attendee) => ({
      ...attendee,
      respondedAt: attendee.respondedAt?.toISOString() ?? null,
      createdAt: attendee.createdAt?.toISOString() ?? null,
      updatedAt: attendee.updatedAt?.toISOString() ?? null,
    })),
  };
}

function attendeeInputs(
  input: readonly z.output<typeof attendeeSchema>[],
): readonly CalendarAttendeeInput[] {
  return input.map((attendee) => ({
    ...(attendee.actorId === undefined ? {} : { actorId: attendee.actorId }),
    email: attendee.email,
    ...(attendee.displayName === undefined ? {} : { displayName: attendee.displayName }),
    role: attendee.role,
    responseStatus: attendee.responseStatus,
    metadata: toJsonObject(attendee.metadata),
  }));
}

function updatePatchFromInput(
  input: z.output<typeof updatePatchSchema>,
): Parameters<CalendarStore["updateEvent"]>[0]["patch"] {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.startsAt === undefined ? {} : { startsAt: new Date(input.startsAt) }),
    ...(input.endsAt === undefined ? {} : { endsAt: new Date(input.endsAt) }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
    ...(input.recurrenceRule === undefined ? {} : { recurrenceRule: input.recurrenceRule }),
    ...(input.attendees === undefined ? {} : { attendees: attendeeInputs(input.attendees) }),
    ...(input.metadata === undefined ? {} : { metadata: toJsonObject(input.metadata) }),
  };
}

function toJsonObject(value: Record<string, unknown> | undefined): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

function hasFreeBusyStore(store: CalendarStore): store is CalendarStore & CalendarFreeBusyStore {
  return (
    "listCalendarFreeBusyEvents" in store && typeof store.listCalendarFreeBusyEvents === "function"
  );
}
