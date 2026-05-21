import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import type { CalendarInvitationSender } from "./ics.js";
import type { CalendarStore } from "./store.js";
import { registerCalendarTools } from "./tools.js";
import type { CalendarEventRecord, CalendarFindTimeSlot } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const calendarId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-05-20T12:00:00.000Z");

describe("calendar tools", () => {
  it("registers a read-safe calendar.event.list tool", () => {
    const registry = createToolRegistry();
    registerCalendarTools(registry, { store: new FakeCalendarStore() });

    expect(registry.get("calendar.event.list")).toMatchObject({
      id: "calendar.event.list",
      permission: "calendar.read",
      sideEffects: "read",
    });
    expect(registry.get("calendar.event.list")?.confirmationRequired).toBeUndefined();
  });

  it("lists events visible to the actor with optional filters", async () => {
    const store = new FakeCalendarStore();
    const registry = createToolRegistry();
    registerCalendarTools(registry, { store });
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["calendar.read"],
    };

    const result = await registry.invoke<{ readonly events: readonly CalendarEventRecord[] }>(
      "calendar.event.list",
      {
        calendarId,
        startsAt: "2026-05-20T00:00:00.000Z",
        endsAt: "2026-05-21T00:00:00.000Z",
        limit: 25,
      },
      { actor },
    );

    expect(result.ok).toBe(true);
    expect(store.listInputs[0]).toMatchObject({ orgId, actorId, calendarId, limit: 25 });
    expect(store.listInputs[0]?.startsAt?.toISOString()).toBe("2026-05-20T00:00:00.000Z");
    expect(store.listInputs[0]?.endsAt?.toISOString()).toBe("2026-05-21T00:00:00.000Z");
    expect(result.ok ? result.output.events : []).toMatchObject([
      {
        id: eventId,
        calendarId,
        title: "Planning",
        startsAt: "2026-05-20T13:00:00.000Z",
        endsAt: "2026-05-20T14:00:00.000Z",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  });

  it("queues invitations on event create when requested", async () => {
    const store = new FakeCalendarStore();
    const invitationSender = new FakeInvitationSender();
    const registry = createToolRegistry();
    registerCalendarTools(registry, {
      store,
      invitationSender,
      rsvpBaseUrl: "https://helix.example.com",
    });
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["calendar.write"],
    };

    const result = await registry.invoke<{ readonly invitationsQueued: number }>(
      "calendar.event.create",
      {
        calendarId,
        title: "Planning",
        startsAt: "2026-05-20T13:00:00.000Z",
        endsAt: "2026-05-20T14:00:00.000Z",
        attendees: [{ email: "bruno@example.com", displayName: "Bruno" }],
        sendInvitations: true,
      },
      { actor },
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.output.invitationsQueued : 0).toBe(1);
    expect(invitationSender.inputs).toHaveLength(1);
    expect(invitationSender.inputs[0]).toMatchObject({
      orgId,
      actorId,
      method: "REQUEST",
      rsvpBaseUrl: "https://helix.example.com",
    });
  });

  it("updates and cancels events through the store and invitation sender", async () => {
    const store = new FakeCalendarStore();
    const invitationSender = new FakeInvitationSender();
    const registry = createToolRegistry();
    registerCalendarTools(registry, {
      store,
      invitationSender,
      rsvpBaseUrl: "https://helix.example.com",
    });
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["calendar.write"],
    };

    const updateResult = await registry.invoke<{ readonly invitationsQueued: number }>(
      "calendar.event.update",
      {
        eventId,
        patch: {
          title: "Updated planning",
          startsAt: "2026-05-20T15:00:00.000Z",
          endsAt: "2026-05-20T16:00:00.000Z",
        },
      },
      { actor },
    );
    const deleteResult = await registry.invoke<{ readonly cancellationsQueued: number }>(
      "calendar.event.delete",
      {
        eventId,
      },
      { actor },
    );

    expect(updateResult.ok).toBe(true);
    expect(updateResult.ok ? updateResult.output.invitationsQueued : 0).toBe(1);
    expect(store.updateInputs[0]).toMatchObject({
      orgId,
      actorId,
      eventId,
      patch: { title: "Updated planning" },
    });
    expect(store.updateInputs[0]?.patch.startsAt?.toISOString()).toBe("2026-05-20T15:00:00.000Z");
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.ok ? deleteResult.output.cancellationsQueued : 0).toBe(1);
    expect(store.deleteInputs[0]).toMatchObject({ orgId, actorId, eventId });
    expect(invitationSender.inputs.map((input) => input.method)).toEqual(["REQUEST", "CANCEL"]);
  });

  it("records attendee responses and serializes find-time slots", async () => {
    const store = new FakeCalendarStore();
    const invitationSender = new FakeInvitationSender();
    const registry = createToolRegistry();
    registerCalendarTools(registry, { store, invitationSender });
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["calendar.write:respond", "calendar.read:freebusy"],
    };

    const responseResult = await registry.invoke<{
      readonly attendees: readonly unknown[];
      readonly rsvpRepliesQueued: number;
    }>(
      "calendar.event.respond",
      {
        eventId,
        attendeeEmail: "bruno@example.com",
        responseStatus: "accepted",
      },
      { actor },
    );
    const findTimeResult = await registry.invoke<{
      readonly slots: readonly CalendarFindTimeSlot[];
    }>(
      "calendar.find-time",
      {
        attendeeActorIds: ["55555555-5555-4555-8555-555555555555"],
        attendeeEmails: ["bruno@example.com"],
        windowStartsAt: "2026-05-20T12:00:00.000Z",
        windowEndsAt: "2026-05-20T18:00:00.000Z",
        durationMinutes: 30,
      },
      { actor },
    );

    expect(responseResult.ok).toBe(true);
    expect(store.respondInputs[0]).toMatchObject({
      orgId,
      actorId,
      eventId,
      attendeeEmail: "bruno@example.com",
      responseStatus: "accepted",
    });
    expect(responseResult.ok ? responseResult.output.attendees : []).toMatchObject([
      { email: "bruno@example.com", responseStatus: "accepted" },
    ]);
    expect(responseResult.ok ? responseResult.output.rsvpRepliesQueued : 0).toBe(1);
    expect(invitationSender.replyInputs[0]).toMatchObject({
      orgId,
      actorId,
      event: { id: eventId },
      attendee: { email: "bruno@example.com", responseStatus: "accepted" },
    });
    expect(findTimeResult.ok).toBe(true);
    expect(store.findTimeInputs[0]).toMatchObject({
      orgId,
      actorId,
      attendeeEmails: ["bruno@example.com"],
      durationMinutes: 30,
      limit: 10,
    });
    expect(findTimeResult.ok ? findTimeResult.output.slots : []).toEqual([
      {
        startsAt: "2026-05-20T14:00:00.000Z",
        endsAt: "2026-05-20T14:30:00.000Z",
        busy: [
          {
            eventId,
            actorId,
            email: "bruno@example.com",
            startsAt: "2026-05-20T13:00:00.000Z",
            endsAt: "2026-05-20T14:00:00.000Z",
          },
        ],
      },
    ]);
  });
});

class FakeCalendarStore implements CalendarStore {
  readonly listInputs: Parameters<CalendarStore["listCalendarEventsForActor"]>[0][] = [];
  readonly updateInputs: Parameters<CalendarStore["updateEvent"]>[0][] = [];
  readonly deleteInputs: Parameters<CalendarStore["deleteEvent"]>[0][] = [];
  readonly respondInputs: Parameters<CalendarStore["respondToEvent"]>[0][] = [];
  readonly findTimeInputs: Parameters<CalendarStore["findTime"]>[0][] = [];

  async createEvent(
    input: Parameters<CalendarStore["createEvent"]>[0],
  ): Promise<CalendarEventRecord> {
    return eventRecord({
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
  }

  async updateEvent(
    input: Parameters<CalendarStore["updateEvent"]>[0],
  ): Promise<CalendarEventRecord | null> {
    this.updateInputs.push(input);
    return eventRecord({
      title: input.patch.title,
      startsAt: input.patch.startsAt,
      endsAt: input.patch.endsAt,
    });
  }

  async deleteEvent(
    input: Parameters<CalendarStore["deleteEvent"]>[0],
  ): Promise<CalendarEventRecord | null> {
    this.deleteInputs.push(input);
    return {
      ...eventRecord(),
      status: "cancelled",
      deletedAt: new Date("2026-05-20T14:00:00.000Z"),
    };
  }

  async respondToEvent(
    input: Parameters<CalendarStore["respondToEvent"]>[0],
  ): Promise<CalendarEventRecord | null> {
    this.respondInputs.push(input);
    return eventRecord({ attendeeResponseStatus: input.responseStatus });
  }

  async findTime(
    input: Parameters<NonNullable<CalendarStore["findTime"]>>[0],
  ): Promise<readonly CalendarFindTimeSlot[]> {
    this.findTimeInputs.push(input);
    return [
      {
        startsAt: new Date("2026-05-20T14:00:00.000Z"),
        endsAt: new Date("2026-05-20T14:30:00.000Z"),
        busy: [
          {
            eventId,
            actorId,
            email: "bruno@example.com",
            startsAt: new Date("2026-05-20T13:00:00.000Z"),
            endsAt: new Date("2026-05-20T14:00:00.000Z"),
          },
        ],
      },
    ];
  }

  async getEventForActor(): Promise<CalendarEventRecord | null> {
    return eventRecord();
  }

  async listCalendarEventsForActor(
    input: Parameters<CalendarStore["listCalendarEventsForActor"]>[0],
  ): Promise<readonly CalendarEventRecord[]> {
    this.listInputs.push(input);
    return [eventRecord()];
  }

  async authenticateAppPassword(): Promise<Actor | null> {
    return null;
  }
}

class FakeInvitationSender implements CalendarInvitationSender {
  readonly inputs: Parameters<CalendarInvitationSender["sendInvitation"]>[0][] = [];
  readonly replyInputs: Parameters<NonNullable<CalendarInvitationSender["sendReply"]>>[0][] = [];

  async sendInvitation(
    input: Parameters<CalendarInvitationSender["sendInvitation"]>[0],
  ): ReturnType<CalendarInvitationSender["sendInvitation"]> {
    this.inputs.push(input);
    return [
      {
        id: "outbound-1",
      },
    ] as unknown as Awaited<ReturnType<CalendarInvitationSender["sendInvitation"]>>;
  }

  async sendReply(
    input: Parameters<NonNullable<CalendarInvitationSender["sendReply"]>>[0],
  ): ReturnType<NonNullable<CalendarInvitationSender["sendReply"]>> {
    this.replyInputs.push(input);
    return [
      {
        id: "outbound-reply-1",
      },
    ] as unknown as Awaited<ReturnType<NonNullable<CalendarInvitationSender["sendReply"]>>>;
  }
}

function eventRecord(
  input: {
    readonly title?: string | undefined;
    readonly startsAt?: Date | undefined;
    readonly endsAt?: Date | undefined;
    readonly attendeeResponseStatus?: "needs_action" | "accepted" | "declined" | "tentative";
  } = {},
): CalendarEventRecord {
  return {
    id: eventId,
    orgId,
    calendarId,
    threadId: null,
    uid: `${eventId}@calendar.helix.local`,
    title: input.title ?? "Planning",
    description: null,
    location: null,
    startsAt: input.startsAt ?? new Date("2026-05-20T13:00:00.000Z"),
    endsAt: input.endsAt ?? new Date("2026-05-20T14:00:00.000Z"),
    timezone: "UTC",
    allDay: false,
    status: "confirmed",
    recurrenceRule: null,
    organizerActorId: actorId,
    organizerEmail: "ada@example.com",
    icsSequence: 0,
    metadata: {},
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    attendees: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        eventId,
        actorId: null,
        email: "bruno@example.com",
        displayName: "Bruno",
        role: "required",
        responseStatus: input.attendeeResponseStatus ?? "needs_action",
        rsvpToken: "rsvp-bruno",
        metadata: {},
        respondedAt:
          input.attendeeResponseStatus === undefined ||
          input.attendeeResponseStatus === "needs_action"
            ? null
            : now,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
