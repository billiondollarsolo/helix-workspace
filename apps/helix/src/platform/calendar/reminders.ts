/**
 * Calendar reminders (CAL.9).
 *
 * Reminder offsets live on event metadata (no dedicated table yet):
 * - `metadata.reminders: [{ minutesBefore: number }, ...]`
 * - or `metadata.reminderMinutesBefore: number | number[]`
 *
 * When neither is set, the default is a single 10-minute pre-event reminder
 * (matches the web settings copy). Cancelled/deleted events never fire.
 *
 * Delivery is through the existing notifications store with verb
 * `calendar.reminder`. A dispatch ledger prevents duplicate deliveries.
 */

import type { JsonObject } from "@helix/sdk-types";
import type { NotificationStore } from "../notifications/index.js";
import type { NotificationInsert } from "../notifications/types.js";
import type { CalendarEventRecord } from "./types.js";

export const CALENDAR_REMINDER_VERB = "calendar.reminder";
export const CALENDAR_REMINDER_OBJECT_TYPE = "calendar_event";
/** Default pre-event lead time (minutes) when metadata omits reminders. */
export const DEFAULT_REMINDER_MINUTES_BEFORE = 10;

export interface CalendarReminderSpec {
  readonly minutesBefore: number;
}

export interface DueCalendarReminder {
  readonly orgId: string;
  readonly eventId: string;
  readonly calendarId: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly minutesBefore: number;
  readonly fireAt: Date;
  /** Stable key for idempotent dispatch: org:event:minutesBefore:occurrenceStartISO */
  readonly dispatchKey: string;
  readonly recipientActorIds: readonly string[];
  readonly timezone: string;
}

export interface ReminderDispatchLedger {
  has(key: string): boolean | Promise<boolean>;
  mark(key: string): void | Promise<void>;
}

export class InMemoryReminderDispatchLedger implements ReminderDispatchLedger {
  readonly #keys = new Set<string>();

  has(key: string): boolean {
    return this.#keys.has(key);
  }

  mark(key: string): void {
    this.#keys.add(key);
  }

  clear(): void {
    this.#keys.clear();
  }
}

/**
 * Parse reminder offsets from event metadata. Invalid entries are dropped.
 * Empty metadata yields the product default (10 minutes).
 * Explicit empty array means "no reminders".
 */
export function parseEventReminders(
  metadata: JsonObject | undefined | null,
): readonly CalendarReminderSpec[] {
  if (metadata === undefined || metadata === null) {
    return [{ minutesBefore: DEFAULT_REMINDER_MINUTES_BEFORE }];
  }

  const list = metadata["reminders"];
  if (Array.isArray(list)) {
    const parsed = list.flatMap((entry) => {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return normalizeMinutes(entry);
      }
      if (isJsonObject(entry) && typeof entry["minutesBefore"] === "number") {
        return normalizeMinutes(entry["minutesBefore"]);
      }
      return [];
    });
    // Explicit empty array = opted out of reminders.
    return parsed;
  }

  const single = metadata["reminderMinutesBefore"];
  if (typeof single === "number" && Number.isFinite(single)) {
    return normalizeMinutes(single);
  }
  if (Array.isArray(single)) {
    return single.flatMap((value) =>
      typeof value === "number" && Number.isFinite(value) ? normalizeMinutes(value) : [],
    );
  }

  return [{ minutesBefore: DEFAULT_REMINDER_MINUTES_BEFORE }];
}

export function computeReminderFireAt(startsAt: Date, minutesBefore: number): Date {
  return new Date(startsAt.getTime() - minutesBefore * 60_000);
}

export function reminderDispatchKey(input: {
  readonly orgId: string;
  readonly eventId: string;
  readonly minutesBefore: number;
  readonly occurrenceStartsAt: Date;
}): string {
  return `${input.orgId}:${input.eventId}:${String(input.minutesBefore)}:${input.occurrenceStartsAt.toISOString()}`;
}

/**
 * Collect reminders that should fire at `now` (fireAt <= now < startsAt+grace).
 * Only returns reminders for events in `orgId` when provided (tenant filter).
 */
export function listDueCalendarReminders(input: {
  readonly events: readonly CalendarEventRecord[];
  readonly now: Date;
  /** How far past fireAt a reminder is still eligible (default 15 minutes). */
  readonly lateWindowMs?: number | undefined;
  /** Restrict to a single tenant. */
  readonly orgId?: string | undefined;
}): readonly DueCalendarReminder[] {
  const lateWindowMs = input.lateWindowMs ?? 15 * 60_000;
  const due: DueCalendarReminder[] = [];

  for (const event of input.events) {
    if (input.orgId !== undefined && event.orgId !== input.orgId) {
      continue;
    }
    if (event.deletedAt !== null || event.status === "cancelled") {
      continue;
    }
    if (!(event.startsAt instanceof Date) || Number.isNaN(event.startsAt.getTime())) {
      continue;
    }

    const specs = parseEventReminders(event.metadata);
    const recipients = recipientActorIds(event);
    if (recipients.length === 0) {
      continue;
    }

    for (const spec of specs) {
      const fireAt = computeReminderFireAt(event.startsAt, spec.minutesBefore);
      if (input.now.getTime() < fireAt.getTime()) {
        continue;
      }
      // Drop reminders that are too late (event already started long ago or fire window passed).
      if (input.now.getTime() > fireAt.getTime() + lateWindowMs) {
        continue;
      }
      // Also skip if the event ended more than lateWindow ago.
      if (event.endsAt.getTime() + lateWindowMs < input.now.getTime()) {
        continue;
      }

      due.push({
        orgId: event.orgId,
        eventId: event.id,
        calendarId: event.calendarId,
        title: event.title,
        startsAt: event.startsAt,
        minutesBefore: spec.minutesBefore,
        fireAt,
        dispatchKey: reminderDispatchKey({
          orgId: event.orgId,
          eventId: event.id,
          minutesBefore: spec.minutesBefore,
          occurrenceStartsAt: event.startsAt,
        }),
        recipientActorIds: recipients,
        timezone: event.timezone ?? "UTC",
      });
    }
  }

  return due;
}

export function buildReminderNotifications(
  due: DueCalendarReminder,
): readonly NotificationInsert[] {
  const startsIso = due.startsAt.toISOString();
  const summary =
    due.minutesBefore === 0
      ? `Starting now: ${due.title}`
      : due.minutesBefore === 1
        ? `In 1 minute: ${due.title}`
        : `In ${String(due.minutesBefore)} minutes: ${due.title}`;

  return due.recipientActorIds.map((actorId) => ({
    orgId: due.orgId,
    actorId,
    verb: CALENDAR_REMINDER_VERB,
    objectType: CALENDAR_REMINDER_OBJECT_TYPE,
    objectId: due.eventId,
    summary,
    body: `Starts at ${startsIso}${due.timezone === "UTC" ? " UTC" : ` (${due.timezone})`}.`,
    payload: {
      eventId: due.eventId,
      calendarId: due.calendarId,
      minutesBefore: due.minutesBefore,
      startsAt: startsIso,
      fireAt: due.fireAt.toISOString(),
      dispatchKey: due.dispatchKey,
      timezone: due.timezone,
    },
  }));
}

/**
 * Dispatch due reminders through the notification store, skipping ledger hits.
 * Returns the number of notification rows inserted.
 */
export async function dispatchDueCalendarReminders(input: {
  readonly events: readonly CalendarEventRecord[];
  readonly notifications: Pick<NotificationStore, "insertMany">;
  readonly ledger: ReminderDispatchLedger;
  readonly now?: Date | undefined;
  readonly orgId?: string | undefined;
  readonly lateWindowMs?: number | undefined;
}): Promise<{
  readonly due: number;
  readonly inserted: number;
  readonly skipped: number;
}> {
  const now = input.now ?? new Date();
  const dueList = listDueCalendarReminders({
    events: input.events,
    now,
    ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
    ...(input.lateWindowMs === undefined ? {} : { lateWindowMs: input.lateWindowMs }),
  });

  let inserted = 0;
  let skipped = 0;

  for (const due of dueList) {
    if (await input.ledger.has(due.dispatchKey)) {
      skipped += 1;
      continue;
    }
    // Tenant safety: every notification must carry the event's orgId.
    const notifications = buildReminderNotifications(due).filter(
      (notification) => notification.orgId === due.orgId,
    );
    if (notifications.length === 0) {
      skipped += 1;
      continue;
    }
    await input.notifications.insertMany(notifications);
    await input.ledger.mark(due.dispatchKey);
    inserted += notifications.length;
  }

  return { due: dueList.length, inserted, skipped };
}

function recipientActorIds(event: CalendarEventRecord): readonly string[] {
  const ids = new Set<string>();
  if (event.organizerActorId !== undefined && event.organizerActorId !== null) {
    ids.add(event.organizerActorId);
  }
  for (const attendee of event.attendees) {
    if (attendee.actorId !== null && attendee.responseStatus !== "declined") {
      ids.add(attendee.actorId);
    }
  }
  return [...ids];
}

function normalizeMinutes(value: number): readonly CalendarReminderSpec[] {
  if (!Number.isFinite(value) || value < 0 || value > 7 * 24 * 60) {
    return [];
  }
  return [{ minutesBefore: Math.floor(value) }];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
