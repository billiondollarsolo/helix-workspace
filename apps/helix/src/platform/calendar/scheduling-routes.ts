import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canonicalTimeZone } from "@helix/contracts";
import {
  CalendarResourceConflictError,
  type CalendarSchedulingStore,
} from "./scheduling.js";

const uuid = z.string().uuid();
const windowSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});
const profileSchema = z.object({
  timezone: z.string().min(1).refine(isIanaTimeZone),
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
  workEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
  workLocation: z.string().max(512).nullable().optional(),
  externalAvailability: z.enum(["none", "busy"]),
  holidayCalendarId: uuid.nullable().optional(),
});
const findTimeSchema = windowSchema.extend({
  attendeeActorIds: z.array(uuid).max(49).default([]),
  resourceIds: z.array(uuid).max(20).default([]),
  durationMinutes: z.number().int().min(5).max(1_440),
  incrementMinutes: z.number().int().min(5).max(240).default(15),
  limit: z.number().int().min(1).max(100).default(10),
});
const resourceSchema = z.object({
  calendarId: uuid,
  name: z.string().min(1).max(200),
  kind: z.enum(["room", "equipment"]),
  timezone: z.string().min(1).refine(isIanaTimeZone),
  capacity: z.number().int().positive().nullable().optional(),
  approvalPolicy: z.enum(["auto", "manual"]),
  approverActorId: uuid.nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
}).superRefine((value, context) => {
  if (value.approvalPolicy === "manual" && value.approverActorId == null) {
    context.addIssue({ code: "custom", path: ["approverActorId"], message: "manual approval requires an approver" });
  }
});
const resourceParams = z.object({ resourceId: uuid });
const bookingParams = z.object({ bookingId: uuid });
const bookingSchema = windowSchema.extend({
  eventId: uuid,
});
const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });
const availabilityParams = z.object({ actorId: uuid });

export async function registerCalendarSchedulingRoutes(
  app: FastifyInstance,
  options: {
    readonly store: CalendarSchedulingStore;
    readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  },
): Promise<void> {
  app.put("/api/calendar/scheduling/profile", async (request, reply) => {
    const body = profileSchema.safeParse(request.body);
    if (!body.success || body.data.workStart >= body.data.workEnd) {
      return reply.code(400).send({ error: "invalid_scheduling_profile" });
    }
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.write")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const profile = await options.store.setProfile({
      orgId: actor.orgId,
      actorId: actor.id,
      ...body.data,
    });
    return profile === null
      ? reply.code(404).send({ error: "not_found" })
      : reply.send(profile);
  });

  app.post("/api/calendar/scheduling/find-time", async (request, reply) => {
    const body = findTimeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_find_time" });
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.read:freebusy")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const slots = await options.store.findTime({
        orgId: actor.orgId,
        actorId: actor.id,
        attendeeActorIds: body.data.attendeeActorIds,
        resourceIds: body.data.resourceIds,
        startsAt: new Date(body.data.startsAt),
        endsAt: new Date(body.data.endsAt),
        durationMinutes: body.data.durationMinutes,
        incrementMinutes: body.data.incrementMinutes,
        limit: body.data.limit,
      });
      return { slots };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/calendar/resources", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.read")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    return { resources: await options.store.listResources(actor.orgId) };
  });

  app.post("/api/calendar/resources", async (request, reply) => {
    const body = resourceSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_resource" });
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.manage")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const resource = await options.store.createResource({
      orgId: actor.orgId,
      actorId: actor.id,
      ...body.data,
      metadata: body.data.metadata as JsonObject,
    });
    return resource === null
      ? reply.code(404).send({ error: "not_found" })
      : reply.code(201).send(resource);
  });

  app.post("/api/calendar/resources/:resourceId/bookings", async (request, reply) => {
    const params = resourceParams.safeParse(request.params);
    const body = bookingSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_resource_booking" });
    }
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.write")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const booking = await options.store.requestBooking({
        orgId: actor.orgId,
        actorId: actor.id,
        resourceId: params.data.resourceId,
        eventId: body.data.eventId,
        startsAt: new Date(body.data.startsAt),
        endsAt: new Date(body.data.endsAt),
      });
      return booking === null
        ? await reply.code(404).send({ error: "not_found" })
        : await reply.code(201).send(booking);
    } catch (error) {
      if (error instanceof CalendarResourceConflictError) {
        return reply.code(409).send({ error: "resource_conflict" });
      }
      throw error;
    }
  });

  app.post("/api/calendar/resource-bookings/:bookingId/decision", async (request, reply) => {
    const params = bookingParams.safeParse(request.params);
    const body = decisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_booking_decision" });
    }
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.manage")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const booking = await options.store.decideBooking({
        orgId: actor.orgId,
        actorId: actor.id,
        bookingId: params.data.bookingId,
        decision: body.data.decision,
      });
      return booking === null
        ? await reply.code(404).send({ error: "not_found" })
        : await reply.send(booking);
    } catch (error) {
      if (error instanceof CalendarResourceConflictError) {
        return reply.code(409).send({ error: "resource_conflict" });
      }
      throw error;
    }
  });

  app.get("/api/calendar/availability/:actorId", async (request, reply) => {
    const params = availabilityParams.safeParse(request.params);
    const query = windowSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "invalid_availability_window" });
    }
    const actor = await options.actorFromRequest(request);
    if (!hasCalendarScope(actor, "calendar.read:freebusy")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const busy = await options.store.externalAvailability({
        orgId: actor.orgId,
        targetActorId: params.data.actorId,
        startsAt: new Date(query.data.startsAt),
        endsAt: new Date(query.data.endsAt),
      });
      return busy === null
        ? await reply.code(404).send({ error: "availability_not_shared" })
        : await reply.send({ busy });
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
}

function isIanaTimeZone(value: string): boolean {
  try {
    canonicalTimeZone(value);
    return true;
  } catch {
    return false;
  }
}

function hasCalendarScope(actor: Actor, scope: string): boolean {
  return actor.scopes?.includes(scope) === true || actor.scopes?.includes("calendar.*") === true;
}
