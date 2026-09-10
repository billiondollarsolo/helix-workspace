import { canonicalTimeZone } from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";
import { findAvailableSlots, freeBusyEventsToBusyBlocks } from "./freebusy.js";
import { expandCalendarEventOccurrences } from "./recurrence.js";
import type { CalendarStore } from "./store.js";
import type {
  CalendarAvailabilitySlot,
  CalendarFreeBusyEvent,
  CalendarFreeBusyStore,
  CalendarWorkingHours,
} from "./types.js";

const maxActors = 50;
const maxWindowMs = 31 * 86_400_000;

export interface CalendarSchedulingProfile {
  readonly actorId: string;
  readonly timezone: string;
  readonly workDays: readonly number[];
  readonly workStart: string;
  readonly workEnd: string;
  readonly workLocation: string | null;
  readonly externalAvailability: "none" | "busy";
  readonly holidayCalendarId: string | null;
}

export interface CalendarResourceRecord {
  readonly id: string;
  readonly calendarId: string;
  readonly name: string;
  readonly kind: "room" | "equipment";
  readonly timezone: string;
  readonly capacity: number | null;
  readonly approvalPolicy: "auto" | "manual";
  readonly approverActorId: string | null;
  readonly active: boolean;
  readonly metadata: JsonObject;
}

export interface CalendarResourceBookingRecord {
  readonly id: string;
  readonly resourceId: string;
  readonly eventId: string;
  readonly recurrenceId: Date | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: "pending" | "approved" | "rejected" | "cancelled";
  readonly requestedByActorId: string;
  readonly decidedByActorId: string | null;
}

export class CalendarResourceConflictError extends Error {
  override readonly name = "CalendarResourceConflictError";
}

export class PostgresCalendarSchedulingStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly calendarStore: CalendarStore & CalendarFreeBusyStore,
  ) {}

  async setProfile(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly timezone: string;
    readonly workDays: readonly number[];
    readonly workStart: string;
    readonly workEnd: string;
    readonly workLocation?: string | null | undefined;
    readonly externalAvailability: "none" | "busy";
    readonly holidayCalendarId?: string | null | undefined;
  }): Promise<CalendarSchedulingProfile | null> {
    const timezone = canonicalTimeZone(input.timezone);
    const rows = await this.sql<SchedulingProfileRow[]>`
      insert into cal_scheduling_profiles (
        org_id, actor_id, timezone, work_days, work_start, work_end, work_location,
        external_availability, holiday_calendar_id
      )
      select ${input.orgId}, actor.id, ${timezone}, ${input.workDays}, ${input.workStart}::time,
        ${input.workEnd}::time, ${input.workLocation ?? null}, ${input.externalAvailability},
        ${input.holidayCalendarId ?? null}
      from actors actor
      where actor.org_id = ${input.orgId} and actor.id = ${input.actorId}
        and actor.disabled_at is null
        and (${input.holidayCalendarId ?? null}::uuid is null or exists (
          select 1 from cal_calendars calendar
          where calendar.org_id = ${input.orgId} and calendar.id = ${input.holidayCalendarId ?? null}
            and calendar.deleted_at is null and (
              calendar.owner_actor_id = actor.id or exists (
                select 1 from cal_calendar_memberships membership
                where membership.org_id = ${input.orgId} and membership.calendar_id = calendar.id
                  and membership.actor_id = actor.id
              )
            )
        ))
      on conflict (org_id, actor_id) do update set
        timezone = excluded.timezone,
        work_days = excluded.work_days,
        work_start = excluded.work_start,
        work_end = excluded.work_end,
        work_location = excluded.work_location,
        external_availability = excluded.external_availability,
        holiday_calendar_id = excluded.holiday_calendar_id,
        updated_at = statement_timestamp()
      returning *
    `;
    return rows[0] === undefined ? null : mapProfile(rows[0]);
  }

  async findTime(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly attendeeActorIds: readonly string[];
    readonly resourceIds?: readonly string[] | undefined;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly durationMinutes: number;
    readonly incrementMinutes?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarAvailabilitySlot[]> {
    const actorIds = [...new Set([input.actorId, ...input.attendeeActorIds])];
    const resourceIds = [...new Set(input.resourceIds ?? [])];
    const resourceActorIds = resourceIds.map(resourceActorId);
    const scheduleActorIds = [...actorIds, ...resourceActorIds];
    validateWindow(scheduleActorIds, input.startsAt, input.endsAt);
    const profiles = await this.profiles(input.orgId, actorIds);
    const resourceAvailability = await this.resourceAvailability(
      input.orgId,
      resourceIds,
      input.startsAt,
      input.endsAt,
    );
    const busyEvents = [
      ...(await this.calendarStore.listCalendarFreeBusyEvents({
        orgId: input.orgId,
        actorIds,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      })),
      ...(await this.holidayEvents(input.orgId, profiles, input.startsAt, input.endsAt)),
      ...resourceAvailability.events,
    ];
    return findAvailableSlots({
      actorIds: scheduleActorIds,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      durationMinutes: input.durationMinutes,
      incrementMinutes: input.incrementMinutes,
      limit: input.limit,
      busy: freeBusyEventsToBusyBlocks(busyEvents, input),
      workingHoursByActorId: Object.fromEntries(
        scheduleActorIds.map((actorId) => {
          const resourceTimezone = resourceAvailability.timezones[actorId];
          if (resourceTimezone !== undefined) {
            return [
              actorId,
              {
                timezone: resourceTimezone,
                daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
                startsAtHour: 0,
                endsAtHour: 24,
              },
            ];
          }
          const profile = profiles.find((candidate) => candidate.actorId === actorId);
          return [
            actorId,
            profile === undefined
              ? { timezone: "UTC", daysOfWeek: [1, 2, 3, 4, 5], startsAtHour: 9, endsAtHour: 17 }
              : profileWorkingHours(profile),
          ];
        }),
      ),
    });
  }

  async externalAvailability(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }): Promise<readonly { readonly startsAt: Date; readonly endsAt: Date }[] | null> {
    validateWindow([input.targetActorId], input.startsAt, input.endsAt);
    const profiles = await this.profiles(input.orgId, [input.targetActorId]);
    if (profiles[0]?.externalAvailability !== "busy") return null;
    const events = await this.calendarStore.listCalendarFreeBusyEvents({
      orgId: input.orgId,
      actorIds: [input.targetActorId],
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
    return freeBusyEventsToBusyBlocks(events, input).map((block) => ({
      startsAt: block.startsAt,
      endsAt: block.endsAt,
    }));
  }

  async createResource(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly name: string;
    readonly kind: "room" | "equipment";
    readonly timezone: string;
    readonly capacity?: number | null | undefined;
    readonly approvalPolicy: "auto" | "manual";
    readonly approverActorId?: string | null | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<CalendarResourceRecord | null> {
    const timezone = canonicalTimeZone(input.timezone);
    const rows = await this.sql<ResourceRow[]>`
      insert into cal_resources (
        org_id, calendar_id, name, kind, timezone, capacity, approval_policy,
        approver_actor_id, metadata
      )
      select ${input.orgId}, calendar.id, ${input.name}, ${input.kind}, ${timezone},
        ${input.capacity ?? null}, ${input.approvalPolicy}, ${input.approverActorId ?? null},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))}
      from cal_calendars calendar
      where calendar.org_id = ${input.orgId} and calendar.id = ${input.calendarId}
        and calendar.deleted_at is null
        and (calendar.owner_actor_id = ${input.actorId} or exists (
          select 1 from cal_calendar_memberships membership
          where membership.org_id = ${input.orgId} and membership.calendar_id = calendar.id
            and membership.actor_id = ${input.actorId} and membership.role in ('owner', 'manager')
        ))
      returning *
    `;
    return rows[0] === undefined ? null : mapResource(rows[0]);
  }

  async listResources(orgId: string): Promise<readonly CalendarResourceRecord[]> {
    const rows = await this.sql<ResourceRow[]>`
      select * from cal_resources where org_id = ${orgId} and active order by kind, lower(name)
      limit 250
    `;
    return rows.map(mapResource);
  }

  async requestBooking(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly resourceId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }): Promise<CalendarResourceBookingRecord | null> {
    const event = await this.calendarStore.getEventForActor({
      orgId: input.orgId,
      actorId: input.actorId,
      eventId: input.eventId,
    });
    if (
      event === null ||
      (event.organizerActorId !== input.actorId &&
        !(await this.canManageCalendar(input.orgId, input.actorId, event.calendarId)))
    ) {
      return null;
    }
    const occurrences = expandCalendarEventOccurrences(
      event,
      new Date(input.startsAt.getTime() - 1),
      new Date(input.endsAt.getTime() + 1),
    );
    const occurrence = occurrences.find(
      (candidate) =>
        candidate.startsAt.getTime() === input.startsAt.getTime() &&
        candidate.endsAt.getTime() === input.endsAt.getTime(),
    );
    if (occurrence === undefined) return null;
    try {
      const rows = await this.sql<BookingRow[]>`
        insert into cal_resource_bookings (
          org_id, resource_id, event_id, recurrence_id, starts_at, ends_at, status,
          requested_by_actor_id
        )
        select resource.org_id, resource.id, ${input.eventId}, ${occurrence.recurrenceId ?? null},
          ${input.startsAt}, ${input.endsAt},
          case resource.approval_policy when 'manual' then 'pending' else 'approved' end,
          ${input.actorId}
        from cal_resources resource
        where resource.org_id = ${input.orgId} and resource.id = ${input.resourceId} and resource.active
        returning *
      `;
      return rows[0] === undefined ? null : mapBooking(rows[0]);
    } catch (error) {
      throwResourceConflict(error);
    }
  }

  async decideBooking(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly bookingId: string;
    readonly decision: "approved" | "rejected";
  }): Promise<CalendarResourceBookingRecord | null> {
    try {
      const rows = await this.sql<BookingRow[]>`
        update cal_resource_bookings booking set
          status = ${input.decision}, decided_by_actor_id = ${input.actorId},
          decided_at = statement_timestamp(), updated_at = statement_timestamp()
        from cal_resources resource
        where booking.org_id = ${input.orgId} and booking.id = ${input.bookingId}
          and booking.status = 'pending' and resource.org_id = booking.org_id
          and resource.id = booking.resource_id and resource.approval_policy = 'manual'
          and resource.approver_actor_id = ${input.actorId}
        returning booking.*
      `;
      return rows[0] === undefined ? null : mapBooking(rows[0]);
    } catch (error) {
      throwResourceConflict(error);
    }
  }

  private async profiles(
    orgId: string,
    actorIds: readonly string[],
  ): Promise<readonly CalendarSchedulingProfile[]> {
    const rows = await this.sql<SchedulingProfileRow[]>`
      select profile.* from cal_scheduling_profiles profile
      join actors actor on actor.org_id = profile.org_id and actor.id = profile.actor_id
      where profile.org_id = ${orgId} and profile.actor_id = any(${actorIds}::uuid[])
        and actor.disabled_at is null
    `;
    return rows.map(mapProfile);
  }

  private async canManageCalendar(
    orgId: string,
    actorId: string,
    calendarId: string,
  ): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      select calendar.id from cal_calendars calendar
      where calendar.org_id = ${orgId} and calendar.id = ${calendarId}
        and calendar.deleted_at is null and (
          calendar.owner_actor_id = ${actorId} or exists (
            select 1 from cal_calendar_memberships membership
            where membership.org_id = ${orgId} and membership.calendar_id = calendar.id
              and membership.actor_id = ${actorId} and membership.role in ('owner', 'manager')
          )
        )
      limit 1
    `;
    return rows[0] !== undefined;
  }

  private async holidayEvents(
    orgId: string,
    profiles: readonly CalendarSchedulingProfile[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<readonly CalendarFreeBusyEvent[]> {
    const calendars = profiles.flatMap((profile) =>
      profile.holidayCalendarId === null
        ? []
        : [{ actorId: profile.actorId, calendarId: profile.holidayCalendarId }],
    );
    if (calendars.length === 0) return [];
    const rows = await this.sql<HolidayEventRow[]>`
      select event.id as event_id, event.calendar_id, event.starts_at, event.ends_at,
        event.timezone, event.all_day, event.time_semantics, event.starts_local,
        event.status, event.recurrence_rule, event.metadata
      from cal_events event
      where event.org_id = ${orgId} and event.calendar_id = any(${calendars.map((item) => item.calendarId)}::uuid[])
        and event.deleted_at is null and event.starts_at < ${endsAt}
        and (event.ends_at > ${startsAt} or event.recurrence_rule is not null)
    `;
    return rows.flatMap((row) =>
      calendars
        .filter((candidate) => candidate.calendarId === row.calendar_id)
        .map((candidate) => ({
          eventId: row.event_id,
          actorId: candidate.actorId,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          timezone: row.timezone,
          allDay: row.all_day,
          timeSemantics: row.time_semantics,
          startsLocal: row.starts_local,
          status: row.status,
          recurrenceRule: row.recurrence_rule,
          metadata: row.metadata,
        })),
    );
  }

  private async resourceAvailability(
    orgId: string,
    resourceIds: readonly string[],
    startsAt: Date,
    endsAt: Date,
  ): Promise<{
    readonly events: readonly CalendarFreeBusyEvent[];
    readonly timezones: Readonly<Record<string, string>>;
  }> {
    if (resourceIds.length === 0) return { events: [], timezones: {} };
    const resources = await this.sql<{ readonly id: string; readonly timezone: string }[]>`
      select id, timezone from cal_resources
      where org_id = ${orgId} and id = any(${resourceIds}::uuid[]) and active
    `;
    if (resources.length !== resourceIds.length) {
      throw new RangeError("Scheduling resource is unavailable.");
    }
    const bookings = await this.sql<
      {
        readonly id: string;
        readonly resource_id: string;
        readonly starts_at: Date;
        readonly ends_at: Date;
      }[]
    >`
      select id, resource_id, starts_at, ends_at from cal_resource_bookings
      where org_id = ${orgId} and resource_id = any(${resourceIds}::uuid[])
        and status = 'approved' and starts_at < ${endsAt} and ends_at > ${startsAt}
    `;
    return {
      timezones: Object.fromEntries(
        resources.map((resource) => [resourceActorId(resource.id), resource.timezone]),
      ),
      events: bookings.map((booking) => ({
        eventId: booking.id,
        actorId: resourceActorId(booking.resource_id),
        startsAt: booking.starts_at,
        endsAt: booking.ends_at,
      })),
    };
  }
}

export type CalendarSchedulingStore = Pick<
  PostgresCalendarSchedulingStore,
  | "setProfile"
  | "findTime"
  | "externalAvailability"
  | "createResource"
  | "listResources"
  | "requestBooking"
  | "decideBooking"
>;

interface SchedulingProfileRow {
  readonly actor_id: string;
  readonly timezone: string;
  readonly work_days: readonly number[];
  readonly work_start: string;
  readonly work_end: string;
  readonly work_location: string | null;
  readonly external_availability: "none" | "busy";
  readonly holiday_calendar_id: string | null;
}

interface ResourceRow {
  readonly id: string;
  readonly calendar_id: string;
  readonly name: string;
  readonly kind: "room" | "equipment";
  readonly timezone: string;
  readonly capacity: number | null;
  readonly approval_policy: "auto" | "manual";
  readonly approver_actor_id: string | null;
  readonly active: boolean;
  readonly metadata: JsonObject;
}

interface BookingRow {
  readonly id: string;
  readonly resource_id: string;
  readonly event_id: string;
  readonly recurrence_id: Date | null;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly status: CalendarResourceBookingRecord["status"];
  readonly requested_by_actor_id: string;
  readonly decided_by_actor_id: string | null;
}

type HolidayEventRow = {
  readonly event_id: string;
  readonly calendar_id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly timezone: string;
  readonly all_day: boolean;
  readonly time_semantics: "zoned" | "floating" | "all_day";
  readonly starts_local: string;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly recurrence_rule: string | null;
  readonly metadata: JsonObject;
};

function mapProfile(row: SchedulingProfileRow): CalendarSchedulingProfile {
  return {
    actorId: row.actor_id,
    timezone: row.timezone,
    workDays: row.work_days,
    workStart: row.work_start.slice(0, 5),
    workEnd: row.work_end.slice(0, 5),
    workLocation: row.work_location,
    externalAvailability: row.external_availability,
    holidayCalendarId: row.holiday_calendar_id,
  };
}

function profileWorkingHours(profile: CalendarSchedulingProfile): CalendarWorkingHours {
  return {
    timezone: profile.timezone,
    daysOfWeek: profile.workDays,
    startsAtHour: timeToHour(profile.workStart),
    endsAtHour: timeToHour(profile.workEnd),
  };
}

function mapResource(row: ResourceRow): CalendarResourceRecord {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    name: row.name,
    kind: row.kind,
    timezone: row.timezone,
    capacity: row.capacity,
    approvalPolicy: row.approval_policy,
    approverActorId: row.approver_actor_id,
    active: row.active,
    metadata: row.metadata,
  };
}

function mapBooking(row: BookingRow): CalendarResourceBookingRecord {
  return {
    id: row.id,
    resourceId: row.resource_id,
    eventId: row.event_id,
    recurrenceId: row.recurrence_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    requestedByActorId: row.requested_by_actor_id,
    decidedByActorId: row.decided_by_actor_id,
  };
}

function validateWindow(actorIds: readonly string[], startsAt: Date, endsAt: Date): void {
  if (
    actorIds.length === 0 ||
    actorIds.length > maxActors ||
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(endsAt.getTime()) ||
    endsAt <= startsAt ||
    endsAt.getTime() - startsAt.getTime() > maxWindowMs
  ) {
    throw new RangeError("Scheduling requires 1-50 actors and a valid window of at most 31 days.");
  }
}

function timeToHour(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) + Number(minutes) / 60;
}

function resourceActorId(resourceId: string): string {
  return `resource:${resourceId}`;
}

function throwResourceConflict(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "23P01" || error.code === "23505")
  ) {
    throw new CalendarResourceConflictError("Resource is already booked for that interval.");
  }
  throw error;
}
