import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Actor, JsonObject } from "@helix/sdk-types";
import { verifySecret } from "../auth/oauth.js";
import type {
  CalendarAttendeeRecord,
  CalendarAttendeeRole,
  CalendarBusyInterval,
  CalendarEventRecord,
  CalendarEventStatus,
  CalendarFindTimeSlot,
  CalendarListEntry,
  CalendarMembershipRole,
  CalendarRecord,
  CalendarResponseStatus,
  CalendarSearchProjectionStore,
  CalendarSearchRecord,
  CalendarFreeBusyEvent,
  CalendarFreeBusyRequest,
} from "./types.js";
import { expandCalendarEventOccurrences } from "./recurrence.js";
import { activityChainHash } from "../activity/hash-chain.js";

export interface CalendarAttendeeInput {
  readonly actorId?: string | null | undefined;
  readonly email: string;
  readonly displayName?: string | null | undefined;
  readonly role?: CalendarAttendeeRole | undefined;
  readonly responseStatus?: CalendarResponseStatus | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface CreateCalendarEventInput {
  readonly id?: string | undefined;
  readonly orgId: string;
  readonly actorId: string;
  readonly calendarId?: string | null | undefined;
  readonly uid?: string | undefined;
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
}

export interface UpdateCalendarEventInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly patch: Partial<{
    readonly title: string;
    readonly description: string | null;
    readonly location: string | null;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly timezone: string;
    readonly allDay: boolean;
    readonly recurrenceRule: string | null;
    readonly attendees: readonly CalendarAttendeeInput[];
    readonly metadata: JsonObject;
  }>;
}

export interface CalendarStore {
  createEvent(input: CreateCalendarEventInput): Promise<CalendarEventRecord>;
  updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null>;
  deleteEvent(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
  }): Promise<CalendarEventRecord | null>;
  respondToEvent(input: {
    readonly orgId?: string | undefined;
    readonly actorId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly attendeeEmail?: string | undefined;
    readonly rsvpToken?: string | undefined;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<CalendarEventRecord | null>;
  findTime(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly attendeeActorIds: readonly string[];
    readonly attendeeEmails: readonly string[];
    readonly windowStartsAt: Date;
    readonly windowEndsAt: Date;
    readonly durationMinutes: number;
    readonly stepMinutes?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarFindTimeSlot[]>;
  getEventForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
  }): Promise<CalendarEventRecord | null>;
  listCalendarEventsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId?: string | undefined;
    readonly startsAt?: Date | undefined;
    readonly endsAt?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarEventRecord[]>;
  authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
  }): Promise<Actor | null>;
  /**
   * List the calendars an actor sees in their sidebar — calendars they own
   * ("My calendars") plus calendars they are a member of ("Team") — with the
   * actor's membership metadata (role, visibility, colour override).
   */
  listCalendarsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly CalendarListEntry[]>;
}

interface CalendarRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string;
  readonly name: string;
  readonly color: string | null;
  readonly timezone: string;
  readonly description: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CalendarMembershipRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly timezone: string;
  readonly color: string | null;
  readonly owner_actor_id: string;
  readonly owner_display_name: string | null;
  readonly color_override: string | null;
  readonly visible: boolean;
  readonly sort_order: number;
  readonly role: CalendarMembershipRole;
  readonly event_count: number;
}

interface EventRow {
  readonly id: string;
  readonly org_id: string;
  readonly calendar_id: string;
  readonly thread_id: string | null;
  readonly uid: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly timezone: string;
  readonly all_day: boolean;
  readonly status: CalendarEventStatus;
  readonly recurrence_rule: string | null;
  readonly organizer_actor_id: string | null;
  readonly organizer_email: string | null;
  readonly ics_sequence: number;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AttendeeRow {
  readonly id: string;
  readonly org_id: string;
  readonly event_id: string;
  readonly actor_id: string | null;
  readonly email: string;
  readonly display_name: string | null;
  readonly role: CalendarAttendeeRole;
  readonly response_status: CalendarResponseStatus;
  readonly is_organizer: boolean;
  readonly rsvp_token: string;
  readonly responded_at: Date | null;
  readonly metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export class PostgresCalendarStore implements CalendarStore, CalendarSearchProjectionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEventRecord> {
    validateTimeRange(input.startsAt, input.endsAt);
    return this.sql.begin(async (tx) => {
      const calendar =
        input.calendarId === undefined || input.calendarId === null
          ? await ensureDefaultCalendar(tx, input.orgId, input.actorId, input.timezone ?? "UTC")
          : await requireCalendarAccess(tx, input.orgId, input.actorId, input.calendarId);
      const actor = await getActor(tx, input.orgId, input.actorId);
      const threadRows = (await tx`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (${input.orgId}, 'calendar', ${input.title}, ${input.actorId}, ${tx.json(toSqlJson({ calendarId: calendar.id }))})
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const threadId = threadRows[0]?.id ?? null;
      const rows = (await tx`
        insert into cal_events (
          id, org_id, calendar_id, thread_id, uid, title, description, location, starts_at, ends_at, timezone,
          all_day, status, recurrence_rule, organizer_actor_id, organizer_email, metadata
        )
        values (
          ${input.id ?? randomUUID()}, ${input.orgId}, ${calendar.id}, ${threadId}, ${input.uid ?? `${randomUUID()}@helix.local`}, ${input.title},
          ${input.description ?? null}, ${input.location ?? null}, ${input.startsAt}, ${input.endsAt},
          ${input.timezone ?? calendar.timezone}, ${input.allDay ?? false}, 'confirmed',
          ${input.recurrenceRule ?? null}, ${input.actorId}, ${actor?.email ?? null}, ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly EventRow[];
      const event = mapEvent(rows[0], []);
      await replaceAttendees(tx, event, input.actorId, actor?.email ?? null, input.attendees ?? []);
      await grantAccess(
        tx,
        input.orgId,
        input.actorId,
        "calendar",
        calendar.id,
        "owner",
        input.actorId,
      );
      await grantAccess(tx, input.orgId, input.actorId, "event", event.id, "owner", input.actorId);
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.event.created",
        event.id,
        { title: input.title },
      );
      return requireEventForActor(tx, input.orgId, input.actorId, event.id);
    });
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const orgId = requireValue(input.orgId, "orgId");
      const actorId = requireValue(input.actorId, "actorId");
      const current = await selectEventForActor(tx, orgId, actorId, input.eventId);
      if (current === null) {
        return null;
      }
      const startsAt = input.patch.startsAt ?? current.startsAt;
      const endsAt = input.patch.endsAt ?? current.endsAt;
      validateTimeRange(startsAt, endsAt);
      const rows = (await tx`
        update cal_events
        set
          title = ${input.patch.title ?? current.title},
          description = ${input.patch.description === undefined ? (current.description ?? null) : input.patch.description},
          location = ${input.patch.location === undefined ? (current.location ?? null) : input.patch.location},
          starts_at = ${startsAt},
          ends_at = ${endsAt},
          timezone = ${input.patch.timezone ?? current.timezone ?? "UTC"},
          all_day = ${input.patch.allDay ?? current.allDay},
          recurrence_rule = ${input.patch.recurrenceRule === undefined ? (current.recurrenceRule ?? null) : input.patch.recurrenceRule},
          metadata = ${tx.json(toSqlJson(input.patch.metadata ?? current.metadata))},
          ics_sequence = ics_sequence + 1,
          updated_at = now()
        where id = ${input.eventId} and org_id = ${orgId} and deleted_at is null
        returning *
      `) as unknown as readonly EventRow[];
      const updated = mapEvent(rows[0], []);
      if (input.patch.attendees !== undefined) {
        const actor = await getActor(tx, orgId, actorId);
        await replaceAttendees(tx, updated, actorId, actor?.email ?? null, input.patch.attendees);
      }
      await appendCalendarActivity(tx, orgId, actorId, "calendar.event.updated", input.eventId, {});
      return requireEventForActor(tx, orgId, actorId, input.eventId);
    });
  }

  async deleteEvent(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
  }): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const current = await selectEventForActor(tx, input.orgId, input.actorId, input.eventId);
      if (current === null) {
        return null;
      }
      await tx`
        update cal_events
        set status = 'cancelled', deleted_at = now(), ics_sequence = ics_sequence + 1, updated_at = now()
        where id = ${input.eventId} and org_id = ${input.orgId}
      `;
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.event.deleted",
        input.eventId,
        {},
      );
      return {
        ...current,
        status: "cancelled",
        deletedAt: new Date(),
        icsSequence: current.icsSequence + 1,
      };
    });
  }

  async respondToEvent(input: {
    readonly orgId?: string | undefined;
    readonly actorId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly attendeeEmail?: string | undefined;
    readonly rsvpToken?: string | undefined;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const eventId = input.eventId ?? null;
      const orgId = input.orgId ?? null;
      const actorId = input.actorId ?? null;
      const attendeeEmail = input.attendeeEmail ?? "";
      const rows =
        input.rsvpToken !== undefined
          ? ((await tx`
            update cal_attendees
            set response_status = ${input.responseStatus}, responded_at = now(), updated_at = now()
            where rsvp_token = ${input.rsvpToken}
            returning event_id, org_id
          `) as unknown as readonly { readonly event_id: string; readonly org_id: string }[])
          : ((await tx`
            update cal_attendees
            set response_status = ${input.responseStatus}, responded_at = now(), updated_at = now()
            where event_id = ${eventId}
              and org_id = ${orgId}
              and (
                actor_id = ${actorId}
                or lower(email) = lower(${attendeeEmail})
              )
            returning event_id, org_id
          `) as unknown as readonly { readonly event_id: string; readonly org_id: string }[]);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      await tx`update cal_events set updated_at = now() where id = ${row.event_id}`;
      await appendCalendarActivity(
        tx,
        row.org_id,
        input.actorId ?? null,
        "calendar.event.responded",
        row.event_id,
        {
          responseStatus: input.responseStatus,
          ...(input.attendeeEmail === undefined ? {} : { attendeeEmail: input.attendeeEmail }),
        },
      );
      return selectEventById(tx, row.org_id, row.event_id);
    });
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
    const targetActorIds = [...new Set([input.actorId, ...input.attendeeActorIds])];
    const targetEmails = [...new Set(input.attendeeEmails.map((email) => email.toLowerCase()))];
    const busyRows = (await this.sql`
      select e.id as event_id, e.starts_at, e.ends_at, e.recurrence_rule, e.metadata, a.actor_id, a.email, e.title
      from cal_events e
      join cal_attendees a on a.event_id = e.id
      where e.org_id = ${input.orgId}
        and e.deleted_at is null
        and e.status <> 'cancelled'
        and a.response_status <> 'declined'
        and e.starts_at < ${input.windowEndsAt}
        and (e.ends_at > ${input.windowStartsAt} or e.recurrence_rule is not null)
        and (
          a.actor_id = any(${targetActorIds})
          or lower(a.email) = any(${targetEmails})
          or e.organizer_actor_id = any(${targetActorIds})
        )
      order by e.starts_at
    `) as unknown as readonly {
      readonly event_id: string;
      readonly starts_at: Date;
      readonly ends_at: Date;
      readonly recurrence_rule: string | null;
      readonly metadata: JsonObject;
      readonly actor_id: string | null;
      readonly email: string | null;
      readonly title: string;
    }[];
    const busy = busyRows.flatMap((row) =>
      expandCalendarEventOccurrences(
        {
          id: row.event_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          recurrenceRule: row.recurrence_rule,
          metadata: row.metadata,
        },
        input.windowStartsAt,
        input.windowEndsAt,
      ).map((occurrence) => ({
        eventId: occurrence.eventId,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        actorId: row.actor_id,
        email: row.email,
        title: row.title,
      })),
    );
    return findOpenSlots(
      busy,
      input.windowStartsAt,
      input.windowEndsAt,
      input.durationMinutes,
      input.stepMinutes ?? 15,
      input.limit ?? 10,
    );
  }

  getEventForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
  }): Promise<CalendarEventRecord | null> {
    return selectEventForActor(this.sql, input.orgId, input.actorId, input.eventId);
  }

  async listCalendarEventsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId?: string | undefined;
    readonly startsAt?: Date | undefined;
    readonly endsAt?: Date | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarEventRecord[]> {
    const rows = (await this.sql`
      select e.*
      from cal_events e
      join cal_calendars c on c.id = e.calendar_id
      where e.org_id = ${input.orgId}
        and e.deleted_at is null
        and (${input.calendarId ?? null}::uuid is null or e.calendar_id = ${input.calendarId ?? null})
        and (${input.startsAt ?? null}::timestamptz is null or e.ends_at > ${input.startsAt ?? null} or e.recurrence_rule is not null)
        and (${input.endsAt ?? null}::timestamptz is null or e.starts_at < ${input.endsAt ?? null})
        and (c.owner_actor_id = ${input.actorId} or e.organizer_actor_id = ${input.actorId} or exists (
          select 1 from cal_attendees a where a.event_id = e.id and a.actor_id = ${input.actorId}
        ) or exists (
          select 1 from permissions p where p.resource_type = 'event' and p.resource_id = e.id and p.actor_id = ${input.actorId}
        ))
      order by e.starts_at
      limit ${input.limit ?? 250}
    `) as unknown as readonly EventRow[];
    return hydrateEvents(this.sql, rows);
  }

  async listCalendarFreeBusyEvents(
    input: CalendarFreeBusyRequest,
  ): Promise<readonly CalendarFreeBusyEvent[]> {
    const rows = (await this.sql`
      select e.id as event_id, e.starts_at, e.ends_at, e.status, e.recurrence_rule, e.metadata, a.actor_id
      from cal_events e
      join cal_attendees a on a.event_id = e.id
      where e.org_id = ${input.orgId}
        and e.deleted_at is null
        and e.starts_at < ${input.endsAt}
        and (e.ends_at > ${input.startsAt} or e.recurrence_rule is not null)
        and a.response_status <> 'declined'
        and a.actor_id = any(${input.actorIds})
      order by e.starts_at
    `) as unknown as readonly {
      readonly event_id: string;
      readonly starts_at: Date;
      readonly ends_at: Date;
      readonly status: CalendarEventStatus;
      readonly recurrence_rule: string | null;
      readonly metadata: JsonObject;
      readonly actor_id: string;
    }[];
    return rows.map((row) => ({
      eventId: row.event_id,
      actorId: row.actor_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      recurrenceRule: row.recurrence_rule,
      metadata: row.metadata,
    }));
  }

  async getCalendarSearchRecord(eventId: string): Promise<CalendarSearchRecord | null> {
    const rows = (await this.sql`
      select * from cal_events where id = ${eventId} limit 1
    `) as unknown as readonly EventRow[];
    return rows[0] === undefined
      ? null
      : mapCalendarSearchRecord(await hydrateEvent(this.sql, rows[0]));
  }

  async authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
  }): Promise<Actor | null> {
    const rows = (await this.sql`
      select a.id, a.org_id, a.type, a.email, a.display_name, a.scopes as actor_scopes, p.id as password_id, p.hash, p.scopes as password_scopes
      from app_passwords p
      join actors a on a.id = p.actor_id
      where p.revoked_at is null
        and (p.expires_at is null or p.expires_at > now())
        and a.disabled_at is null
        and (lower(a.email) = lower(${input.username}) or a.id::text = ${input.username})
    `) as unknown as readonly {
      readonly id: string;
      readonly org_id: string;
      readonly type: Actor["type"];
      readonly email: string | null;
      readonly display_name: string;
      readonly actor_scopes: readonly string[];
      readonly password_id: string;
      readonly hash: string;
      readonly password_scopes: readonly string[];
    }[];
    for (const row of rows) {
      const scopes = [...new Set([...row.actor_scopes, ...row.password_scopes])];
      if (!scopes.includes(input.requiredScope) && !scopes.includes("caldav")) {
        continue;
      }
      if (await verifySecret(input.password, row.hash)) {
        await this.sql`update app_passwords set last_used_at = now() where id = ${row.password_id}`;
        return {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          displayName: row.display_name,
          scopes,
          ...(row.email === null ? {} : { email: row.email }),
        };
      }
    }
    return null;
  }

  async listCalendarsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly CalendarListEntry[]> {
    // Source of truth is `cal_calendar_memberships`, which carries an "owner"
    // row for every calendar (materialised by migration 0021). Owned calendars
    // are also picked up directly so a calendar created before the membership
    // backfill — or by a path that has not yet written one — still appears.
    const rows = (await this.sql`
      with entries as (
        select
          c.id, c.org_id, c.name, c.description, c.timezone, c.color,
          c.owner_actor_id,
          m.role::text as role,
          coalesce(m.visible, true) as visible,
          m.color_override,
          coalesce(m.sort_order, case when c.owner_actor_id = ${input.actorId} then 0 else 100 end) as sort_order
        from cal_calendars c
        left join cal_calendar_memberships m
          on m.calendar_id = c.id and m.actor_id = ${input.actorId}
        where c.org_id = ${input.orgId}
          and c.deleted_at is null
          and (c.owner_actor_id = ${input.actorId} or m.actor_id is not null)
      )
      select
        e.id, e.org_id, e.name, e.description, e.timezone, e.color,
        e.owner_actor_id,
        e.color_override,
        e.visible,
        e.sort_order,
        coalesce(
          e.role,
          case when e.owner_actor_id = ${input.actorId} then 'owner' else 'reader' end
        ) as role,
        a.display_name as owner_display_name,
        coalesce((
          select count(*)::int from cal_events ev
          where ev.calendar_id = e.id and ev.deleted_at is null
        ), 0) as event_count
      from entries e
      left join actors a on a.id = e.owner_actor_id
      order by e.sort_order asc, lower(e.name) asc
    `) as unknown as readonly CalendarMembershipRow[];
    return rows.map((row) => mapCalendarListEntry(row, input.actorId));
  }
}

async function ensureDefaultCalendar(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  timezone: string,
): Promise<CalendarRecord> {
  const existing = (await sql`
    select * from cal_calendars
    where org_id = ${orgId} and owner_actor_id = ${actorId} and deleted_at is null
    order by created_at
    limit 1
  `) as unknown as readonly CalendarRow[];
  if (existing[0] !== undefined) {
    return mapCalendar(existing[0]);
  }
  const rows = (await sql`
    insert into cal_calendars (org_id, owner_actor_id, name, timezone)
    values (${orgId}, ${actorId}, 'Calendar', ${timezone})
    returning *
  `) as unknown as readonly CalendarRow[];
  return mapCalendar(rows[0]);
}

async function requireCalendarAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string | null,
  calendarId: string,
): Promise<CalendarRecord> {
  const rows = (await sql`
    select * from cal_calendars
    where id = ${calendarId}
      and org_id = ${orgId}
      and deleted_at is null
      and (owner_actor_id = ${actorId} or exists (
        select 1 from permissions p where p.resource_type = 'calendar' and p.resource_id = cal_calendars.id and p.actor_id = ${actorId}
      ))
  `) as unknown as readonly CalendarRow[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown or inaccessible calendar: ${calendarId}`);
  }
  return mapCalendar(rows[0]);
}

async function selectEventForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string | null,
  eventId: string,
): Promise<CalendarEventRecord | null> {
  const rows = (await sql`
    select e.*
    from cal_events e
    join cal_calendars c on c.id = e.calendar_id
    where e.id = ${eventId}
      and e.org_id = ${orgId}
      and e.deleted_at is null
      and (c.owner_actor_id = ${actorId} or e.organizer_actor_id = ${actorId} or exists (
        select 1 from cal_attendees a where a.event_id = e.id and a.actor_id = ${actorId}
      ) or exists (
        select 1 from permissions p where p.resource_type = 'event' and p.resource_id = e.id and p.actor_id = ${actorId}
      ))
    limit 1
  `) as unknown as readonly EventRow[];
  return rows[0] === undefined ? null : hydrateEvent(sql, rows[0]);
}

async function selectEventById(
  sql: SqlLike,
  orgId: string,
  eventId: string,
): Promise<CalendarEventRecord | null> {
  const rows = (await sql`
    select * from cal_events where id = ${eventId} and org_id = ${orgId} limit 1
  `) as unknown as readonly EventRow[];
  return rows[0] === undefined ? null : hydrateEvent(sql, rows[0]);
}

async function requireEventForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  eventId: string,
): Promise<CalendarEventRecord> {
  const event = await selectEventForActor(sql, orgId, actorId, eventId);
  if (event === null) {
    throw new Error(`Unknown or inaccessible calendar event: ${eventId}`);
  }
  return event;
}

async function hydrateEvents(
  sql: SqlLike,
  rows: readonly EventRow[],
): Promise<readonly CalendarEventRecord[]> {
  const events: CalendarEventRecord[] = [];
  for (const row of rows) {
    events.push(await hydrateEvent(sql, row));
  }
  return events;
}

async function hydrateEvent(sql: SqlLike, row: EventRow): Promise<CalendarEventRecord> {
  const attendeeRows = (await sql`
    select * from cal_attendees where event_id = ${row.id} order by is_organizer desc, email
  `) as unknown as readonly AttendeeRow[];
  return mapEvent(row, attendeeRows.map(mapAttendee));
}

async function replaceAttendees(
  sql: SqlLike,
  event: CalendarEventRecord,
  actorId: string,
  organizerEmail: string | null,
  attendees: readonly CalendarAttendeeInput[],
): Promise<void> {
  await sql`delete from cal_attendees where event_id = ${event.id}`;
  const normalized = new Map<string, CalendarAttendeeInput>();
  if (organizerEmail !== null) {
    normalized.set(organizerEmail.toLowerCase(), {
      actorId,
      email: organizerEmail,
      displayName: null,
      role: "required",
      responseStatus: "accepted",
    });
  }
  for (const attendee of attendees) {
    normalized.set(attendee.email.toLowerCase(), attendee);
  }
  for (const attendee of normalized.values()) {
    const isOrganizer =
      attendee.actorId === actorId ||
      (organizerEmail !== null && attendee.email.toLowerCase() === organizerEmail.toLowerCase());
    await sql`
      insert into cal_attendees (
        org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, rsvp_token, metadata
      )
      values (
        ${event.orgId}, ${event.id}, ${attendee.actorId ?? null}, ${attendee.email}, ${attendee.displayName ?? null},
        ${attendee.role ?? "required"}, ${isOrganizer ? "accepted" : (attendee.responseStatus ?? "needs_action")},
        ${isOrganizer}, ${randomUUID()}, ${sql.json(toSqlJson(attendee.metadata ?? {}))}
      )
    `;
    if (attendee.actorId !== undefined && attendee.actorId !== null) {
      await grantAccess(
        sql,
        event.orgId,
        attendee.actorId,
        "event",
        event.id,
        isOrganizer ? "owner" : "participant",
        actorId,
      );
    }
  }
}

async function getActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): Promise<{ readonly email: string | null } | null> {
  const rows = (await sql`
    select email from actors where id = ${actorId} and org_id = ${orgId} limit 1
  `) as unknown as readonly { readonly email: string | null }[];
  return rows[0] ?? null;
}

async function grantAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  resourceType: string,
  resourceId: string,
  role: string,
  grantedByActorId: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${grantedByActorId})
    on conflict do nothing
  `;
}

async function appendCalendarActivity(
  sql: SqlLike,
  orgId: string,
  actorId: string | null,
  verb: string,
  eventId: string,
  payload: JsonObject,
): Promise<void> {
  const previousRows = (await sql`
    select this_hash from activity where org_id = ${orgId} order by created_at desc limit 1
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const thisHash = activityChainHash({
    prevHash,
    verb,
    objectId: eventId,
    timestamp: Date.now(),
  });
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (${orgId}, ${actorId}, ${verb}, 'event', ${eventId}, ${sql.json(toSqlJson(payload))}, ${prevHash}, ${thisHash})
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${verb}`}, ${sql.json(
      toSqlJson({
        orgId,
        actorId,
        eventId,
        id: eventId,
        ...payload,
      }),
    )})
  `;
}

function findOpenSlots(
  busy: readonly CalendarBusyInterval[],
  windowStartsAt: Date,
  windowEndsAt: Date,
  durationMinutes: number,
  stepMinutes: number,
  limit: number,
): readonly CalendarFindTimeSlot[] {
  const slots: CalendarFindTimeSlot[] = [];
  const durationMs = durationMinutes * 60_000;
  const stepMs = stepMinutes * 60_000;
  for (
    let startsMs = windowStartsAt.getTime();
    startsMs + durationMs <= windowEndsAt.getTime();
    startsMs += stepMs
  ) {
    const endsMs = startsMs + durationMs;
    const conflicts = busy.some(
      (interval) => interval.startsAt.getTime() < endsMs && interval.endsAt.getTime() > startsMs,
    );
    if (!conflicts) {
      slots.push({ startsAt: new Date(startsMs), endsAt: new Date(endsMs), busy: [] });
      if (slots.length >= limit) {
        break;
      }
    }
  }
  return slots;
}

function validateTimeRange(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new Error("Calendar event end must be after start.");
  }
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`Calendar ${name} is required.`);
  }
  return value;
}

function mapCalendar(row: CalendarRow | undefined): CalendarRecord {
  if (row === undefined) {
    throw new Error("Expected calendar row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    name: row.name,
    color: row.color,
    timezone: row.timezone,
    description: row.description,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Default calendar colour when neither the calendar nor the membership sets one. */
const DEFAULT_CALENDAR_COLOR = "#4f46e5";

function mapCalendarListEntry(row: CalendarMembershipRow, actorId: string): CalendarListEntry {
  const writable = row.role === "owner" || row.role === "writer";
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    color: row.color_override ?? row.color ?? DEFAULT_CALENDAR_COLOR,
    ownerActorId: row.owner_actor_id,
    ownerDisplayName: row.owner_display_name,
    role: row.role,
    visible: row.visible,
    group: row.owner_actor_id === actorId ? "mine" : "team",
    writable,
    sortOrder: row.sort_order,
    eventCount: row.event_count,
  };
}

function mapEvent(
  row: EventRow | undefined,
  attendees: readonly CalendarAttendeeRecord[],
): CalendarEventRecord {
  if (row === undefined) {
    throw new Error("Expected calendar event row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    calendarId: row.calendar_id,
    threadId: row.thread_id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    allDay: row.all_day,
    status: row.status,
    recurrenceRule: row.recurrence_rule,
    organizerActorId: row.organizer_actor_id,
    organizerEmail: row.organizer_email,
    icsSequence: row.ics_sequence,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attendees,
  };
}

function mapCalendarSearchRecord(event: CalendarEventRecord): CalendarSearchRecord {
  const visibility = calendarVisibility(event.metadata.visibility);
  const classification = calendarClassification(event.metadata.classification);
  return {
    id: event.id,
    orgId: event.orgId,
    calendarId: event.calendarId,
    title: event.title,
    ...(event.description === null || event.description === undefined
      ? {}
      : { description: event.description }),
    ...(event.location === null || event.location === undefined
      ? {}
      : { location: event.location }),
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    status: event.status,
    ...(visibility === undefined ? {} : { visibility }),
    ...(classification === undefined ? {} : { classification }),
    ...(event.organizerActorId === null && event.organizerEmail === null
      ? {}
      : {
          organizer: {
            id: event.organizerActorId ?? "unknown",
            ...(event.organizerEmail === null || event.organizerEmail === undefined
              ? {}
              : { email: event.organizerEmail }),
          },
        }),
    attendees: event.attendees.map((attendee) => ({
      ...(attendee.actorId === null ? {} : { actorId: attendee.actorId }),
      email: attendee.email,
      ...(attendee.displayName === null || attendee.displayName === undefined
        ? {}
        : { displayName: attendee.displayName }),
      responseStatus: attendee.responseStatus,
    })),
    ...(event.uid === undefined ? {} : { icsUid: event.uid }),
    metadata: event.metadata,
    ...(event.deletedAt === null ? {} : { deletedAt: event.deletedAt.toISOString() }),
    updatedAt: event.updatedAt.toISOString(),
  };
}

function mapAttendee(row: AttendeeRow): CalendarAttendeeRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    eventId: row.event_id,
    actorId: row.actor_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    responseStatus: row.response_status,
    isOrganizer: row.is_organizer,
    rsvpToken: row.rsvp_token,
    respondedAt: row.responded_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function calendarVisibility(value: unknown): CalendarSearchRecord["visibility"] {
  return value === "default" ||
    value === "public" ||
    value === "private" ||
    value === "confidential"
    ? value
    : undefined;
}

function calendarClassification(value: unknown): CalendarSearchRecord["classification"] {
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? value
    : undefined;
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
