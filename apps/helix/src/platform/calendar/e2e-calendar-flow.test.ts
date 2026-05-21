import { describe, expect, it } from "vitest";
import type {
  AICallContext,
  AICapability,
  Actor,
  ChatRequest,
  ChatResponse,
  EventBus,
  EventEnvelope,
  JsonObject,
  JsonValue,
  SuggestionSlotProviderCapability,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { SearchEventIndexer } from "../search/event-indexer.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "../search/types.js";
import { createToolRegistry } from "../tool-registry.js";
import { getCalendarFreeBusy } from "./freebusy.js";
import { createIcsCalendar } from "./ics.js";
import { createCalendarSuggestionSlotProviders, registerCalendarIndexer, registerCalendarTools } from "./index.js";
import type { CalendarAttendeeInput, CalendarStore, UpdateCalendarEventInput } from "./store.js";
import type {
  CalendarAttendeeRecord,
  CalendarBusyInterval,
  CalendarEventRecord,
  CalendarFindTimeSlot,
  CalendarFreeBusyEvent,
  CalendarFreeBusyRequest,
  CalendarSearchProjectionStore,
  CalendarSearchRecord,
} from "./types.js";

describe("calendar AI/free-busy/search flow", () => {
  it("covers create update respond find-time ICS search and AI with fakes", async () => {
    const ada = actor("00000000-0000-4000-8000-000000000001", "Ada", "ada@example.com");
    const bruno = actor("00000000-0000-4000-8000-000000000002", "Bruno", "bruno@example.com");
    const calendarId = "00000000-0000-4000-8000-000000000101";
    const events = new FakeEventBus();
    const engine = new FakeSearchEngine();
    const calendar = new FakeCalendarService(events);
    const ai = new FakeAI();
    const registry = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });

    registerCalendarTools(registry, { store: calendar });
    const indexer = new SearchEventIndexer({ events, engine });
    registerCalendarIndexer(indexer, calendar);
    await indexer.start();

    const createResult = await registry.invoke<{ readonly id: string }>("calendar.event.create", {
      calendarId,
      title: "Launch planning",
      description: "Review launch risks and owner follow-up.",
      location: "Conference Room A",
      startsAt: "2026-05-20T15:00:00.000Z",
      endsAt: "2026-05-20T16:00:00.000Z",
      timezone: "UTC",
      attendees: [{ actorId: bruno.id, email: bruno.email, displayName: bruno.displayName }],
      metadata: { source: "e2e" },
      sendInvitations: false,
    }, { actor: ada });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      throw new Error(createResult.error);
    }

    const eventId = createResult.output.id;
    const updateResult = await registry.invoke("calendar.event.update", {
      eventId,
      title: "Launch planning review",
      location: "Conference Room B",
      sendInvitations: false,
    }, { actor: ada });
    expect(updateResult.ok).toBe(true);

    const respondResult = await registry.invoke("calendar.event.respond", {
      eventId,
      responseStatus: "accepted",
    }, { actor: bruno });
    expect(respondResult.ok).toBe(true);

    await calendar.createBusyHold({
      actor: bruno,
      calendarId,
      title: "Customer call",
      startsAt: new Date("2026-05-20T16:00:00.000Z"),
      endsAt: new Date("2026-05-20T16:30:00.000Z"),
    });

    const busy = await getCalendarFreeBusy(calendar, {
      orgId: ada.orgId,
      actorIds: [ada.id, bruno.id],
      startsAt: new Date("2026-05-20T14:00:00.000Z"),
      endsAt: new Date("2026-05-20T18:00:00.000Z"),
    });
    const findTime = await registry.invoke<{ readonly slots: readonly { readonly startsAt: string; readonly endsAt: string }[] }>(
      "calendar.find-time",
      {
        attendeeActorIds: [bruno.id],
        windowStartsAt: "2026-05-20T14:00:00.000Z",
        windowEndsAt: "2026-05-20T18:00:00.000Z",
        durationMinutes: 30,
        stepMinutes: 30,
      },
      { actor: ada },
    );
    expect(findTime.ok).toBe(true);
    if (!findTime.ok) {
      throw new Error(findTime.error);
    }

    const search = await engine.search({
      query: "launch risks bruno",
      types: ["calendar"],
      filter: `attributes.calendarId = "${calendarId}"`,
    });
    const stored = calendar.requireEvent(eventId);
    const ics = createIcsCalendar({ event: stored });

    const providers = createCalendarSuggestionSlotProviders({ ai });
    const suggestTime = requiredProvider(providers, "calendar.suggest-meeting-time");
    const draftAgenda = requiredProvider(providers, "calendar.draft-agenda");
    const timeSuggestion = await collectSuggestion(suggestTime.generate({
      actor: ada,
      feature: "calendar.suggest-meeting-time",
      resource: { type: "calendar.event", id: eventId, orgId: ada.orgId },
      input: {
        title: stored.title,
        attendees: [ada.displayName, bruno.displayName].filter((name): name is string => name !== undefined),
        durationMinutes: 30,
        slots: findTime.output.slots,
      },
    }));
    const agenda = await collectSuggestion(draftAgenda.generate({
      actor: ada,
      feature: "calendar.draft-agenda",
      resource: { type: "calendar.event", id: eventId, orgId: ada.orgId },
      input: {
        title: stored.title,
        purpose: "Align on launch risks and owners.",
        attendees: stored.attendees.map((attendee) => attendee.displayName ?? attendee.email),
        notes: stored.description ?? "",
      },
    }));

    const deleteResult = await registry.invoke("calendar.event.delete", {
      eventId,
      sendCancellation: false,
    }, { actor: ada });
    const deletedSearch = await engine.search({ query: "launch risks bruno", types: ["calendar"] });
    await indexer.stop();

    expect(stored.location).toBe("Conference Room B");
    expect(stored.attendees.find((attendee) => attendee.actorId === bruno.id)?.responseStatus).toBe("accepted");
    expect(busy.flatMap((block) => block.eventIds)).toEqual(expect.arrayContaining([eventId]));
    expect(findTime.output.slots.map((slot) => slot.startsAt)).toContain("2026-05-20T14:00:00.000Z");
    expect(findTime.output.slots.map((slot) => slot.startsAt)).not.toContain("2026-05-20T15:00:00.000Z");
    expect(search.hits.map((hit) => hit.id)).toContain(`calendar:${eventId}`);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("SUMMARY:Launch planning review");
    expect(timeSuggestion).toContain("Time:");
    expect(agenda).toContain("Agenda:");
    expect(ai.calls.map((call) => call.feature)).toEqual(
      expect.arrayContaining(["calendar.suggest-meeting-time", "calendar.draft-agenda"]),
    );
    expect(deleteResult.ok).toBe(true);
    expect(deletedSearch.hits.map((hit) => hit.id)).not.toContain(`calendar:${eventId}`);
  });
});

class FakeCalendarService implements CalendarStore, CalendarSearchProjectionStore {
  readonly #events = new Map<string, CalendarEventRecord>();
  #next = 1;

  constructor(private readonly events: EventBus) {}

  async createEvent(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId?: string | null | undefined;
    readonly title: string;
    readonly description?: string | null | undefined;
    readonly location?: string | null | undefined;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly timezone?: string | undefined;
    readonly allDay?: boolean | undefined;
    readonly recurrenceRule?: string | null | undefined;
    readonly attendees?: readonly CalendarAttendeeInput[] | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<CalendarEventRecord> {
    const id = eventId(this.#next);
    this.#next += 1;
    const now = new Date("2026-05-20T13:00:00.000Z");
    const organizer = attendeeRecord({
      index: 0,
      orgId: input.orgId,
      eventId: id,
      actorId: input.actorId,
      email: "ada@example.com",
      displayName: "Ada",
      responseStatus: "accepted",
      isOrganizer: true,
    });
    const attendees = [
      organizer,
      ...(input.attendees ?? []).map((attendee, index) => attendeeRecord({
        index: index + 1,
        orgId: input.orgId,
        eventId: id,
        actorId: attendee.actorId ?? null,
        email: attendee.email,
        displayName: attendee.displayName ?? null,
        responseStatus: attendee.responseStatus ?? "needs_action",
        isOrganizer: false,
      })),
    ];
    const event: CalendarEventRecord = {
      id,
      orgId: input.orgId,
      calendarId: input.calendarId ?? "00000000-0000-4000-8000-000000000101",
      threadId: `thread-${id}`,
      uid: `${id}@calendar.helix.local`,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone ?? "UTC",
      allDay: input.allDay ?? false,
      status: "confirmed",
      recurrenceRule: input.recurrenceRule ?? null,
      organizerActorId: input.actorId,
      organizerEmail: "ada@example.com",
      icsSequence: 0,
      metadata: input.metadata ?? {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      attendees,
    };
    this.#events.set(id, event);
    await this.events.publish("activity.calendar.event.created", { eventId: id });
    return event;
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null> {
    const existing = this.#events.get(input.eventId);
    if (existing === undefined || existing.deletedAt !== null) {
      return null;
    }
    const updated = {
      ...existing,
      ...input.patch,
      allDay: input.patch.allDay ?? existing.allDay,
      metadata: input.patch.metadata ?? existing.metadata,
      attendees: input.patch.attendees === undefined ? existing.attendees : input.patch.attendees.map((attendee, index) => attendeeRecord({
        index,
        orgId: existing.orgId,
        eventId: existing.id,
        actorId: attendee.actorId ?? null,
        email: attendee.email,
        displayName: attendee.displayName ?? null,
        responseStatus: attendee.responseStatus ?? "needs_action",
        isOrganizer: false,
      })),
      icsSequence: existing.icsSequence + 1,
      updatedAt: new Date("2026-05-20T13:05:00.000Z"),
    };
    this.#events.set(input.eventId, updated);
    await this.events.publish("activity.calendar.event.updated", { eventId: input.eventId });
    return updated;
  }

  async deleteEvent(input: { readonly eventId: string }): Promise<CalendarEventRecord | null> {
    const existing = this.#events.get(input.eventId);
    if (existing === undefined || existing.deletedAt !== null) {
      return null;
    }
    const deleted = {
      ...existing,
      status: "cancelled" as const,
      deletedAt: new Date("2026-05-20T13:10:00.000Z"),
      updatedAt: new Date("2026-05-20T13:10:00.000Z"),
    };
    this.#events.set(input.eventId, deleted);
    await this.events.publish("activity.calendar.event.deleted", { eventId: input.eventId });
    return deleted;
  }

  async respondToEvent(input: {
    readonly actorId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly responseStatus: "accepted" | "declined" | "tentative";
  }): Promise<CalendarEventRecord | null> {
    if (input.eventId === undefined) {
      return null;
    }
    const existing = this.#events.get(input.eventId);
    if (existing === undefined || existing.deletedAt !== null) {
      return null;
    }
    const attendees = existing.attendees.map((attendee) =>
      attendee.actorId === input.actorId
        ? { ...attendee, responseStatus: input.responseStatus, respondedAt: new Date("2026-05-20T13:06:00.000Z") }
        : attendee,
    );
    const updated = {
      ...existing,
      attendees,
      icsSequence: existing.icsSequence + 1,
      updatedAt: new Date("2026-05-20T13:06:00.000Z"),
    };
    this.#events.set(input.eventId, updated);
    await this.events.publish("activity.calendar.event.responded", {
      eventId: input.eventId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    });
    return updated;
  }

  async findTime(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly attendeeActorIds: readonly string[];
    readonly attendeeEmails: readonly string[];
    readonly windowStartsAt: Date;
    readonly windowEndsAt: Date;
    readonly durationMinutes: number;
    readonly stepMinutes?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarFindTimeSlot[]> {
    const actorIds = [...new Set([input.actorId, ...input.attendeeActorIds])];
    const busy = await this.busyIntervals({
      orgId: input.orgId,
      actorIds,
      startsAt: input.windowStartsAt,
      endsAt: input.windowEndsAt,
    });
    const slots: CalendarFindTimeSlot[] = [];
    const durationMs = input.durationMinutes * 60_000;
    const stepMs = (input.stepMinutes ?? 15) * 60_000;
    for (
      let startsMs = input.windowStartsAt.getTime();
      startsMs + durationMs <= input.windowEndsAt.getTime() && slots.length < (input.limit ?? 10);
      startsMs += stepMs
    ) {
      const endsMs = startsMs + durationMs;
      const conflicts = busy.filter((interval) => interval.startsAt.getTime() < endsMs && interval.endsAt.getTime() > startsMs);
      if (conflicts.length === 0) {
        slots.push({ startsAt: new Date(startsMs), endsAt: new Date(endsMs), busy: [] });
      }
    }
    return slots;
  }

  async getEventForActor(input: { readonly eventId: string }): Promise<CalendarEventRecord | null> {
    return this.#events.get(input.eventId) ?? null;
  }

  async listCalendarEventsForActor(): Promise<readonly CalendarEventRecord[]> {
    return [...this.#events.values()].filter((event) => event.deletedAt === null);
  }

  async authenticateAppPassword(): Promise<Actor | null> {
    return null;
  }

  async listCalendarFreeBusyEvents(input: CalendarFreeBusyRequest): Promise<readonly CalendarFreeBusyEvent[]> {
    return (await this.busyIntervals(input)).map((interval) => ({
      eventId: interval.eventId,
      actorId: interval.actorId ?? "",
      startsAt: interval.startsAt,
      endsAt: interval.endsAt,
      status: "confirmed",
    }));
  }

  async getCalendarSearchRecord(eventIdValue: string): Promise<CalendarSearchRecord | null> {
    const event = this.#events.get(eventIdValue);
    if (event === undefined) {
      return null;
    }
    return {
      id: event.id,
      orgId: event.orgId,
      calendarId: event.calendarId,
      title: event.title,
      ...(event.description === null ? {} : { description: event.description }),
      ...(event.location === null ? {} : { location: event.location }),
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      status: event.status,
      organizer: {
        id: event.organizerActorId ?? "unknown",
        ...(event.organizerEmail === null ? {} : { email: event.organizerEmail }),
      },
      attendees: event.attendees.map((attendee) => ({
        ...(attendee.actorId === null ? {} : { actorId: attendee.actorId }),
        email: attendee.email,
        ...(attendee.displayName === null ? {} : { displayName: attendee.displayName }),
        responseStatus: attendee.responseStatus,
      })),
      icsUid: event.uid,
      ...(event.deletedAt === null ? {} : { deletedAt: event.deletedAt.toISOString() }),
      updatedAt: event.updatedAt.toISOString(),
      metadata: event.metadata,
    };
  }

  async createBusyHold(input: {
    readonly actor: Actor;
    readonly calendarId: string;
    readonly title: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }): Promise<CalendarEventRecord> {
    return this.createEvent({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      calendarId: input.calendarId,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      attendees: [],
      metadata: {},
    });
  }

  requireEvent(eventIdValue: string): CalendarEventRecord {
    const event = this.#events.get(eventIdValue);
    if (event === undefined) {
      throw new Error(`unknown event ${eventIdValue}`);
    }
    return event;
  }

  private async busyIntervals(input: CalendarFreeBusyRequest): Promise<readonly CalendarBusyInterval[]> {
    return [...this.#events.values()]
      .filter((event) => event.orgId === input.orgId)
      .filter((event) => event.deletedAt === null && event.status !== "cancelled")
      .filter((event) => event.startsAt < input.endsAt && input.startsAt < event.endsAt)
      .flatMap((event) => eventActorIds(event).map((actorId) => ({
        eventId: event.id,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        actorId,
        email: event.attendees.find((attendee) => attendee.actorId === actorId)?.email ?? null,
        title: event.title,
      })))
      .filter((interval) => input.actorIds.includes(interval.actorId));
  }
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly docs = new Map<string, IndexDocument>();

  async index(document: IndexDocument): Promise<void> {
    this.docs.set(document.id, document);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    for (const document of documents) {
      this.docs.set(document.id, document);
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hits = [...this.docs.values()].filter((document) => {
      const haystack = `${document.title ?? ""}\n${document.body ?? ""}`.toLowerCase();
      const matchesQuery = terms.every((term) => haystack.includes(term));
      const matchesType = request.types === undefined || request.types.includes(document.type);
      const matchesFilter = matchesCalendarFilter(document, request.filter);
      return matchesQuery && matchesType && matchesFilter;
    });
    return { hits, query: request.query, estimatedTotalHits: hits.length };
  }
}

class FakeAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (request.feature === "calendar.suggest-meeting-time") {
      return {
        message: "Time: 2026-05-20 14:00 UTC works for all required attendees.",
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    return {
      message: "Agenda: 1. Review launch risks. 2. Confirm owners. 3. Capture next steps.",
      model: "fake-model",
      providerId: "fake-ai",
    };
  }
}

class FakeEventBus implements EventBus {
  readonly #subscribers: {
    readonly subject: string;
    readonly handler: (event: EventEnvelope) => Promise<void>;
  }[] = [];

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const event: EventEnvelope = {
      subject,
      payload,
      occurredAt: "2026-05-20T13:00:00.000Z",
      ...(trace === undefined ? {} : { trace }),
    };
    for (const subscriber of this.#subscribers) {
      if (subjectMatches(subscriber.subject, subject)) {
        await subscriber.handler(event);
      }
    }
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    const subscriber = {
      subject,
      handler: handler as (event: EventEnvelope) => Promise<void>,
    };
    this.#subscribers.push(subscriber);
    return () => {
      const index = this.#subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.#subscribers.splice(index, 1);
      }
    };
  }
}

function actor(id: string, displayName: string, email: string): Actor {
  return {
    id,
    orgId: "org-1",
    type: "user",
    displayName,
    email,
    scopes: ["calendar.write", "calendar.write:respond", "calendar.read:freebusy"],
  };
}

function eventId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function attendeeRecord(input: {
  readonly index: number;
  readonly orgId: string;
  readonly eventId: string;
  readonly actorId: string | null;
  readonly email: string;
  readonly displayName: string | null;
  readonly responseStatus: "needs_action" | "accepted" | "declined" | "tentative";
  readonly isOrganizer: boolean;
}): CalendarAttendeeRecord {
  const now = new Date("2026-05-20T13:00:00.000Z");
  return {
    id: `00000000-0000-4000-8001-${String(input.index).padStart(12, "0")}`,
    orgId: input.orgId,
    eventId: input.eventId,
    actorId: input.actorId,
    email: input.email,
    displayName: input.displayName,
    role: "required",
    responseStatus: input.responseStatus,
    isOrganizer: input.isOrganizer,
    rsvpToken: `token-${String(input.index)}`,
    respondedAt: input.responseStatus === "needs_action" ? null : now,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function eventActorIds(event: CalendarEventRecord): readonly string[] {
  return [
    ...(event.organizerActorId === null || event.organizerActorId === undefined ? [] : [event.organizerActorId]),
    ...event.attendees
      .filter((attendee) => attendee.responseStatus !== "declined")
      .map((attendee) => attendee.actorId)
      .filter((actorId): actorId is string => typeof actorId === "string"),
  ];
}

function matchesCalendarFilter(document: IndexDocument, filter: SearchRequest["filter"]): boolean {
  const filters = typeof filter === "string" ? [filter] : (filter ?? []);
  const calendarId = document.attributes?.calendarId;
  return filters.every((candidate) => {
    const match = /attributes\.calendarId\s*=\s*"([^"]+)"/u.exec(candidate);
    return match === null ? true : calendarId === match[1];
  });
}

async function collectSuggestion(chunks: AsyncIterable<{ readonly text: string }>): Promise<string> {
  const text: string[] = [];
  for await (const chunk of chunks) {
    text.push(chunk.text);
  }
  return text.join("");
}

function requiredProvider(
  providers: readonly SuggestionSlotProviderCapability[],
  slotId: string,
): SuggestionSlotProviderCapability {
  const provider = providers.find((candidate) => candidate.slotId === slotId);
  if (provider === undefined) {
    throw new Error(`${slotId} provider missing`);
  }
  return provider;
}

function subjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}
