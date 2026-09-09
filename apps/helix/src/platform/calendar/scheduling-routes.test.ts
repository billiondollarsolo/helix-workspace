import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCalendarSchedulingRoutes } from "./scheduling-routes.js";
import { CalendarResourceConflictError, type CalendarSchedulingStore } from "./scheduling.js";

describe("calendar scheduling routes", () => {
  it("exposes consented availability as anonymous intervals only", async () => {
    const actor = testActor();
    const store = fakeStore();
    store.externalAvailability.mockResolvedValue([
      {
        startsAt: new Date("2026-06-01T13:00:00Z"),
        endsAt: new Date("2026-06-01T14:00:00Z"),
      },
    ]);
    const app = fastify();
    await registerCalendarSchedulingRoutes(app, { store, actorFromRequest: () => actor });

    const response = await app.inject({
      method: "GET",
      url: `/api/calendar/availability/00000000-0000-4000-8000-000000000002?startsAt=2026-06-01T00%3A00%3A00.000Z&endsAt=2026-06-02T00%3A00%3A00.000Z`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      busy: [{ startsAt: "2026-06-01T13:00:00.000Z", endsAt: "2026-06-01T14:00:00.000Z" }],
    });
    expect(response.body).not.toContain("eventId");
  });

  it("returns conflict for a database-rejected double booking", async () => {
    const actor = testActor();
    const store = fakeStore();
    store.requestBooking.mockRejectedValue(
      new CalendarResourceConflictError("Resource is already booked for that interval."),
    );
    const app = fastify();
    await registerCalendarSchedulingRoutes(app, { store, actorFromRequest: () => actor });

    const response = await app.inject({
      method: "POST",
      url: "/api/calendar/resources/00000000-0000-4000-8000-000000000003/bookings",
      payload: {
        eventId: "00000000-0000-4000-8000-000000000004",
        startsAt: "2026-06-01T13:00:00.000Z",
        endsAt: "2026-06-01T14:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "resource_conflict" });
  });

  it("rejects a manual resource without an assigned approver", async () => {
    const actor = testActor();
    const store = fakeStore();
    const app = fastify();
    await registerCalendarSchedulingRoutes(app, { store, actorFromRequest: () => actor });

    const response = await app.inject({
      method: "POST",
      url: "/api/calendar/resources",
      payload: {
        calendarId: "00000000-0000-4000-8000-000000000005",
        name: "Board room",
        kind: "room",
        timezone: "America/New_York",
        approvalPolicy: "manual",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(store.createResource).not.toHaveBeenCalled();
  });
});

function fakeStore() {
  return {
    setProfile: vi.fn<CalendarSchedulingStore["setProfile"]>(),
    findTime: vi.fn<CalendarSchedulingStore["findTime"]>(),
    externalAvailability: vi.fn<CalendarSchedulingStore["externalAvailability"]>(),
    createResource: vi.fn<CalendarSchedulingStore["createResource"]>(),
    listResources: vi.fn<CalendarSchedulingStore["listResources"]>().mockResolvedValue([]),
    requestBooking: vi.fn<CalendarSchedulingStore["requestBooking"]>(),
    decideBooking: vi.fn<CalendarSchedulingStore["decideBooking"]>(),
  };
}

function testActor(): Actor {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000101",
    type: "user",
    displayName: "Ada",
    scopes: ["calendar.read", "calendar.read:freebusy", "calendar.write", "calendar.manage"],
  };
}
