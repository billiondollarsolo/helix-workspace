import {
  canonicalTimeZone,
  instantToLocalDateTime,
  localDateTimeToInstant,
  type CalendarTimeSemantics,
} from "@helix/contracts";
import type { Actor, JsonObject } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { activityChainHash } from "../activity/hash-chain.js";
import { sensitivityClassificationFromMetadata } from "../ai/classification/index.js";
import { restrictAppPasswordActor } from "../auth/app-passwords.js";
import { verifySecret } from "../auth/oauth.js";
import { toSqlJson } from "../util/sql.js";
import { enqueueCalendarInvitationDeliveries } from "./invitation-outbox.js";
import { expandCalendarEventOccurrences } from "./recurrence.js";
import type {
  CalendarAttendeeRecord,
  CalendarAttendeeRole,
  CalendarBusyInterval,
  CalendarEventRecord,
  CalendarEventRevisionKind,
  CalendarEventRevisionRecord,
  CalendarEventStatus,
  CalendarFindTimeSlot,
  CalendarFreeBusyEvent,
  CalendarFreeBusyRequest,
  CalendarListEntry,
  CalendarMembershipRecord,
  CalendarMembershipRole,
  CalendarRecord,
  CalendarResponseStatus,
  CalendarSearchProjectionStore,
  CalendarSearchRecord,
} from "./types.js";

export interface CalendarAttendeeInput {
  readonly actorId?: string | null | undefined;
  readonly email: string;
  readonly displayName?: string | null | undefined;
  readonly role?: CalendarAttendeeRole | undefined;
  readonly responseStatus?: CalendarResponseStatus | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface CalendarRsvpResult {
  readonly event: CalendarEventRecord;
  readonly attendee: CalendarAttendeeRecord;
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
  readonly timeSemantics?: CalendarTimeSemantics | undefined;
  readonly recurrenceRule?: string | null | undefined;
  readonly attendees?: readonly CalendarAttendeeInput[] | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly sendInvitations?: boolean | undefined;
  readonly rsvpBaseUrl?: string | undefined;
}

export interface UpdateCalendarEventInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly expectedIcsSequence?: number | undefined;
  readonly sendInvitations?: boolean | undefined;
  readonly rsvpBaseUrl?: string | undefined;
  readonly patch: Partial<{
    readonly title: string;
    readonly description: string | null;
    readonly location: string | null;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly timezone: string;
    readonly allDay: boolean;
    readonly timeSemantics: CalendarTimeSemantics;
    readonly recurrenceRule: string | null;
    readonly attendees: readonly CalendarAttendeeInput[];
    readonly metadata: JsonObject;
  }>;
}

interface CalendarSyncChange {
  readonly version: number;
  readonly eventId: string;
  readonly event: CalendarEventRecord | null;
}

export interface CalendarSyncPage {
  readonly changes: readonly CalendarSyncChange[];
  /** Revision represented by this page; pass it back to continue. */
  readonly version: number;
  readonly latestVersion: number;
  readonly hasMore: boolean;
}

export interface CalendarStore {
  createEvent(input: CreateCalendarEventInput): Promise<CalendarEventRecord>;
  updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null>;
  deleteEvent(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly expectedIcsSequence?: number | undefined;
    readonly sendInvitations?: boolean | undefined;
    readonly rsvpBaseUrl?: string | undefined;
  }): Promise<CalendarEventRecord | null>;
  listEventRevisions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly beforeRevision?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarEventRevisionRecord[] | null>;
  restoreEventRevision(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly revision: number;
    readonly expectedIcsSequence: number;
  }): Promise<CalendarEventRecord | null>;
  respondToEvent(input: {
    readonly orgId?: string | undefined;
    readonly actorId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<CalendarEventRecord | null>;
  respondToRsvpToken(input: {
    readonly rsvpToken: string;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<CalendarRsvpResult | null>;
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
  listCalendarChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly afterVersion: number;
    readonly limit?: number | undefined;
  }): Promise<CalendarSyncPage | null>;
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
  listCalendarMemberships(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
  }): Promise<readonly CalendarMembershipRecord[] | null>;
  setCalendarMembership(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly memberActorId: string;
    readonly role: Exclude<CalendarMembershipRole, "owner">;
  }): Promise<CalendarMembershipRecord | null>;
  removeCalendarMembership(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly memberActorId: string;
  }): Promise<boolean>;
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
  readonly sync_version: string | number | bigint;
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
  readonly sync_version: string | number | bigint;
}

interface CalendarChangeRow {
  readonly sync_version: string | number | bigint;
  readonly event_id: string;
  readonly deleted: boolean;
}

interface CalendarMemberRow {
  readonly calendar_id: string;
  readonly actor_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly role: CalendarMembershipRole;
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
  readonly time_semantics: CalendarTimeSemantics;
  readonly starts_local: string;
  readonly ends_local: string;
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

interface EventRevisionRow {
  readonly event_id: string;
  readonly revision: number;
  readonly calendar_id: string;
  readonly change_kind: CalendarEventRevisionKind;
  readonly changed_by_actor_id: string | null;
  readonly snapshot: JsonObject;
  readonly created_at: Date;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export class PostgresCalendarStore implements CalendarStore, CalendarSearchProjectionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEventRecord> {
    validateTimeRange(input.startsAt, input.endsAt);
    validateSchedulingMetadata(input.metadata);
    return this.sql.begin(async (tx) => {
      const calendar =
        input.calendarId === undefined || input.calendarId === null
          ? await ensureDefaultCalendar(tx, input.orgId, input.actorId, input.timezone ?? "UTC")
          : await requireCalendarWriteAccess(tx, input.orgId, input.actorId, input.calendarId);
      const actor = await requireActiveCalendarActor(tx, input.orgId, input.actorId);
      const eventTime = resolveCalendarEventTime({
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone ?? calendar.timezone,
        allDay: input.allDay ?? false,
        timeSemantics: input.timeSemantics,
      });
      const threadRows = await tx<{ readonly id: string }[]>`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (${input.orgId}, 'calendar', ${input.title}, ${input.actorId}, ${tx.json(toSqlJson({ calendarId: calendar.id }))})
        returning id
      `;
      const threadId = threadRows[0]?.id ?? null;
      const rows = await tx<EventRow[]>`
        insert into cal_events (
          id, org_id, calendar_id, thread_id, uid, title, description, location, starts_at, ends_at,
          timezone, all_day, time_semantics, starts_local, ends_local, status, recurrence_rule,
          organizer_actor_id, organizer_email, metadata
        )
        values (
          ${input.id ?? randomUUID()}, ${input.orgId}, ${calendar.id}, ${threadId}, ${input.uid ?? `${randomUUID()}@helix.local`}, ${input.title},
          ${input.description ?? null}, ${input.location ?? null}, ${eventTime.startsAt}, ${eventTime.endsAt},
          ${eventTime.timezone}, ${eventTime.allDay}, ${eventTime.timeSemantics},
          ${eventTime.startsLocal}, ${eventTime.endsLocal}, 'confirmed',
          ${input.recurrenceRule ?? null}, ${input.actorId}, ${actor.email}, ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `;
      const event = mapEvent(rows[0], []);
      await syncAttendees(tx, event, input.actorId, actor.email, input.attendees ?? []);
      if (calendar.ownerActorId === input.actorId) {
        await grantAccess(
          tx,
          input.orgId,
          input.actorId,
          "calendar",
          calendar.id,
          "owner",
          input.actorId,
        );
      }
      await grantAccess(tx, input.orgId, input.actorId, "event", event.id, "owner", input.actorId);
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.event.created",
        event.id,
        { title: input.title },
      );
      const created = await requireEventForActor(tx, input.orgId, input.actorId, event.id);
      await appendEventRevision(tx, created.id, "created", input.actorId);
      const invitationDeliveriesQueued = input.sendInvitations
        ? await enqueueCalendarInvitationDeliveries(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            event: created,
            method: "REQUEST",
            ...(input.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: input.rsvpBaseUrl }),
          })
        : 0;
      return { ...created, invitationDeliveriesQueued };
    });
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const orgId = requireValue(input.orgId, "orgId");
      const actorId = requireValue(input.actorId, "actorId");
      const current = await selectEventForActor(tx, orgId, actorId, input.eventId, "write");
      if (current === null) {
        return null;
      }
      validateSchedulingMetadata(input.patch.metadata);
      const eventTime = resolveCalendarEventTime({
        startsAt:
          input.patch.startsAt ??
          (input.patch.timezone !== undefined && current.timeSemantics === "zoned"
            ? localDateTimeToInstant(current.startsLocal ?? "", input.patch.timezone)
            : current.startsAt),
        endsAt:
          input.patch.endsAt ??
          (input.patch.timezone !== undefined && current.timeSemantics === "zoned"
            ? localDateTimeToInstant(current.endsLocal ?? "", input.patch.timezone)
            : current.endsAt),
        timezone: input.patch.timezone ?? current.timezone ?? "UTC",
        allDay: input.patch.allDay ?? current.allDay,
        timeSemantics: input.patch.timeSemantics ?? current.timeSemantics,
      });
      validateTimeRange(eventTime.startsAt, eventTime.endsAt);
      const rows = await tx<EventRow[]>`
        update cal_events
        set
          title = ${input.patch.title ?? current.title},
          description = ${input.patch.description === undefined ? (current.description ?? null) : input.patch.description},
          location = ${input.patch.location === undefined ? (current.location ?? null) : input.patch.location},
          starts_at = ${eventTime.startsAt},
          ends_at = ${eventTime.endsAt},
          timezone = ${eventTime.timezone},
          all_day = ${eventTime.allDay},
          time_semantics = ${eventTime.timeSemantics},
          starts_local = ${eventTime.startsLocal},
          ends_local = ${eventTime.endsLocal},
          recurrence_rule = ${input.patch.recurrenceRule === undefined ? (current.recurrenceRule ?? null) : input.patch.recurrenceRule},
          metadata = ${tx.json(toSqlJson(input.patch.metadata ?? current.metadata))},
          ics_sequence = ics_sequence + 1,
          updated_at = now()
        where id = ${input.eventId} and org_id = ${orgId} and deleted_at is null
          and (${input.expectedIcsSequence ?? null}::integer is null
            or ics_sequence = ${input.expectedIcsSequence ?? null})
        returning *
      `;
      if (rows[0] === undefined) {
        return null;
      }
      const updated = mapEvent(rows[0], []);
      if (
        input.patch.startsAt !== undefined ||
        input.patch.endsAt !== undefined ||
        input.patch.timezone !== undefined ||
        input.patch.allDay !== undefined ||
        input.patch.timeSemantics !== undefined ||
        input.patch.recurrenceRule !== undefined
      ) {
        await cancelResourceBookings(tx, orgId, actorId, input.eventId);
      }
      if (input.patch.attendees !== undefined) {
        const organizerActorId = requireValue(updated.organizerActorId ?? undefined, "organizer");
        const organizer = await requireActiveCalendarActor(tx, orgId, organizerActorId);
        await syncAttendees(tx, updated, organizerActorId, organizer.email, input.patch.attendees);
      }
      await appendCalendarActivity(tx, orgId, actorId, "calendar.event.updated", input.eventId, {});
      const result = await requireEventForActor(tx, orgId, actorId, input.eventId);
      await appendEventRevision(tx, result.id, "updated", actorId);
      let invitationDeliveriesQueued = 0;
      if (input.sendInvitations) {
        invitationDeliveriesQueued += await enqueueCalendarInvitationDeliveries(tx, {
          orgId,
          actorId,
          event: result,
          method: "REQUEST",
          ...(input.rsvpBaseUrl === undefined ? {} : { rsvpBaseUrl: input.rsvpBaseUrl }),
        });
        const currentRecipients = new Set(
          result.attendees.map((attendee) => attendee.email.trim().toLowerCase()),
        );
        const removed = current.attendees.filter(
          (attendee) =>
            attendee.isOrganizer !== true &&
            !currentRecipients.has(attendee.email.trim().toLowerCase()),
        );
        if (removed.length > 0) {
          invitationDeliveriesQueued += await enqueueCalendarInvitationDeliveries(tx, {
            orgId,
            actorId,
            event: {
              ...current,
              icsSequence: result.icsSequence,
              updatedAt: result.updatedAt,
            },
            attendees: removed,
            method: "CANCEL",
          });
        }
      }
      return { ...result, invitationDeliveriesQueued };
    });
  }

  async deleteEvent(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly expectedIcsSequence?: number | undefined;
    readonly sendInvitations?: boolean | undefined;
    readonly rsvpBaseUrl?: string | undefined;
  }): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const current = await selectEventForActor(
        tx,
        input.orgId,
        input.actorId,
        input.eventId,
        "write",
      );
      if (current === null) {
        return null;
      }
      const deletedRows = await tx<{ readonly id: string }[]>`
        update cal_events
        set status = 'cancelled', deleted_at = now(), ics_sequence = ics_sequence + 1, updated_at = now()
        where id = ${input.eventId} and org_id = ${input.orgId} and deleted_at is null
          and (${input.expectedIcsSequence ?? null}::integer is null
            or ics_sequence = ${input.expectedIcsSequence ?? null})
        returning id
      `;
      if (deletedRows[0] === undefined) {
        return null;
      }
      await cancelResourceBookings(tx, input.orgId, input.actorId, input.eventId);
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.event.deleted",
        input.eventId,
        {},
      );
      const deleted = {
        ...current,
        status: "cancelled",
        deletedAt: new Date(),
        icsSequence: current.icsSequence + 1,
      } satisfies CalendarEventRecord;
      await appendEventRevision(tx, deleted.id, "cancelled", input.actorId);
      const invitationDeliveriesQueued = input.sendInvitations
        ? await enqueueCalendarInvitationDeliveries(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            event: deleted,
            method: "CANCEL",
          })
        : 0;
      return { ...deleted, invitationDeliveriesQueued };
    });
  }

  async respondToEvent(input: {
    readonly orgId?: string | undefined;
    readonly actorId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const eventId = input.eventId ?? null;
      const orgId = input.orgId ?? null;
      const actorId = input.actorId ?? null;
      const rows = await tx<{ readonly event_id: string; readonly org_id: string }[]>`
        update cal_attendees
        set response_status = ${input.responseStatus}, responded_at = now(), updated_at = now()
        where event_id = ${eventId}
          and org_id = ${orgId}
          and actor_id = ${actorId}
          and exists (
            select 1 from actors actor
            where actor.id = ${actorId}
              and actor.org_id = ${orgId}
              and actor.disabled_at is null
          )
        returning event_id, org_id
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      await tx`
        update cal_events set ics_sequence = ics_sequence + 1, updated_at = now()
        where org_id = ${row.org_id} and id = ${row.event_id}
      `;
      await appendCalendarActivity(
        tx,
        row.org_id,
        input.actorId ?? null,
        "calendar.event.responded",
        row.event_id,
        {
          responseStatus: input.responseStatus,
        },
      );
      const event = await selectEventById(tx, row.org_id, row.event_id);
      if (event !== null)
        await appendEventRevision(tx, event.id, "responded", input.actorId ?? null);
      return event;
    });
  }

  async respondToRsvpToken(input: {
    readonly rsvpToken: string;
    readonly responseStatus: CalendarResponseStatus;
  }): Promise<CalendarRsvpResult | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        {
          readonly event_id: string;
          readonly org_id: string;
          readonly email: string;
        }[]
      >`
        update cal_attendees
        set response_status = ${input.responseStatus},
            responded_at = now(),
            rsvp_token = gen_random_uuid()::text,
            updated_at = now()
        where rsvp_token = ${input.rsvpToken}
        returning event_id, org_id, email
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      await tx`
        update cal_events set ics_sequence = ics_sequence + 1, updated_at = now()
        where org_id = ${row.org_id} and id = ${row.event_id}
      `;
      await appendCalendarActivity(tx, row.org_id, null, "calendar.event.responded", row.event_id, {
        responseStatus: input.responseStatus,
        external: true,
      });
      const event = await selectEventById(tx, row.org_id, row.event_id);
      if (event !== null) await appendEventRevision(tx, event.id, "responded", null);
      const attendee = event?.attendees.find(
        (candidate) => candidate.email.toLowerCase() === row.email.toLowerCase(),
      );
      return event === null || attendee === undefined ? null : { event, attendee };
    });
  }

  async listEventRevisions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly beforeRevision?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly CalendarEventRevisionRecord[] | null> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const event = await selectEventForActor(
      this.sql,
      input.orgId,
      input.actorId,
      input.eventId,
      "read",
      true,
    );
    if (event === null) return null;
    const rows = await this.sql<EventRevisionRow[]>`
      select event_id, revision, calendar_id, change_kind, changed_by_actor_id, snapshot, created_at
      from cal_event_revisions
      where org_id = ${input.orgId} and event_id = ${input.eventId}
        and (${input.beforeRevision ?? null}::integer is null
          or revision < ${input.beforeRevision ?? null})
      order by revision desc
      limit ${limit}
    `;
    return rows.map(mapEventRevision);
  }

  async restoreEventRevision(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly eventId: string;
    readonly revision: number;
    readonly expectedIcsSequence: number;
  }): Promise<CalendarEventRecord | null> {
    return this.sql.begin(async (tx) => {
      const current = await selectEventForActor(
        tx,
        input.orgId,
        input.actorId,
        input.eventId,
        "write",
        true,
      );
      if (current === null || current.icsSequence !== input.expectedIcsSequence) return null;
      const revisions = await tx<{ readonly snapshot: JsonObject }[]>`
        select snapshot from cal_event_revisions
        where org_id = ${input.orgId} and event_id = ${input.eventId}
          and revision = ${input.revision}
        limit 1
      `;
      const snapshot = revisions[0]?.snapshot;
      if (snapshot === undefined) return null;
      const snapshotJson = tx.json(toSqlJson(snapshot));
      const rows = await tx<EventRow[]>`
        update cal_events event set
          title = ${snapshotJson}->'event'->>'title',
          description = ${snapshotJson}->'event'->>'description',
          location = ${snapshotJson}->'event'->>'location',
          starts_at = (${snapshotJson}->'event'->>'starts_at')::timestamptz,
          ends_at = (${snapshotJson}->'event'->>'ends_at')::timestamptz,
          timezone = ${snapshotJson}->'event'->>'timezone',
          all_day = (${snapshotJson}->'event'->>'all_day')::boolean,
          time_semantics = ${snapshotJson}->'event'->>'time_semantics',
          starts_local = ${snapshotJson}->'event'->>'starts_local',
          ends_local = ${snapshotJson}->'event'->>'ends_local',
          status = ${snapshotJson}->'event'->>'status',
          recurrence_rule = ${snapshotJson}->'event'->>'recurrence_rule',
          metadata = ${snapshotJson}->'event'->'metadata',
          deleted_at = (${snapshotJson}->'event'->>'deleted_at')::timestamptz,
          ics_sequence = event.ics_sequence + 1,
          updated_at = statement_timestamp()
        where event.org_id = ${input.orgId} and event.id = ${input.eventId}
          and event.ics_sequence = ${input.expectedIcsSequence}
        returning *
      `;
      if (rows[0] === undefined) return null;
      await tx`delete from cal_attendees where org_id = ${input.orgId} and event_id = ${input.eventId}`;
      await tx`
        insert into cal_attendees (
          id, org_id, event_id, actor_id, email, display_name, role, response_status,
          is_organizer, rsvp_token, responded_at, metadata, created_at, updated_at
        )
        select attendee.id, ${input.orgId}, ${input.eventId}, attendee.actor_id, attendee.email,
          attendee.display_name, attendee.role, attendee.response_status, attendee.is_organizer,
          gen_random_uuid()::text, attendee.responded_at, coalesce(attendee.metadata, '{}'::jsonb),
          attendee.created_at, statement_timestamp()
        from jsonb_to_recordset(${snapshotJson}->'attendees') as attendee(
          id uuid, actor_id uuid, email text, display_name text, role text,
          response_status text, is_organizer boolean, responded_at timestamptz,
          metadata jsonb, created_at timestamptz
        )
      `;
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.event.restored",
        input.eventId,
        { restoredRevision: input.revision },
      );
      const restored = await selectEventById(tx, input.orgId, input.eventId);
      if (restored === null) return null;
      await appendEventRevision(tx, restored.id, "restored", input.actorId);
      return restored;
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
    const busyRows = await this.sql<
      {
        readonly event_id: string;
        readonly starts_at: Date;
        readonly ends_at: Date;
        readonly timezone: string;
        readonly all_day: boolean;
        readonly time_semantics: CalendarTimeSemantics;
        readonly starts_local: string;
        readonly recurrence_rule: string | null;
        readonly metadata: JsonObject;
        readonly actor_id: string | null;
        readonly email: string | null;
        readonly title: string;
      }[]
    >`
      select e.id as event_id, e.starts_at, e.ends_at, e.timezone, e.all_day,
        e.time_semantics, e.starts_local, e.recurrence_rule, e.metadata, a.actor_id, a.email, e.title
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
    `;
    const busy = busyRows.flatMap((row) =>
      expandCalendarEventOccurrences(
        {
          id: row.event_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          timezone: row.timezone,
          allDay: row.all_day,
          timeSemantics: row.time_semantics,
          startsLocal: row.starts_local,
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
    const rows = await this.sql<EventRow[]>`
      select e.*
      from cal_events e
      join cal_calendars c on c.id = e.calendar_id
      where e.org_id = ${input.orgId}
        and e.deleted_at is null
        and (${input.calendarId ?? null}::uuid is null or e.calendar_id = ${input.calendarId ?? null})
        and (${input.startsAt ?? null}::timestamptz is null or e.ends_at > ${input.startsAt ?? null} or e.recurrence_rule is not null)
        and (${input.endsAt ?? null}::timestamptz is null or e.starts_at < ${input.endsAt ?? null})
        and (c.owner_actor_id = ${input.actorId} or e.organizer_actor_id = ${input.actorId} or exists (
          select 1 from cal_calendar_memberships membership
          where membership.calendar_id = e.calendar_id
            and membership.org_id = ${input.orgId}
            and membership.actor_id = ${input.actorId}
        ) or exists (
          select 1 from cal_attendees a where a.event_id = e.id and a.actor_id = ${input.actorId}
        ) or exists (
          select 1 from permissions p
          where p.resource_type = 'event'
            and p.resource_id = e.id
            and p.org_id = ${input.orgId}
            and p.actor_id = ${input.actorId}
            and (p.expires_at is null or p.expires_at > now())
        ))
      order by e.starts_at
      limit ${input.limit ?? 250}
    `;
    return hydrateEvents(this.sql, rows);
  }

  async listCalendarChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly afterVersion: number;
    readonly limit?: number | undefined;
  }): Promise<CalendarSyncPage | null> {
    const calendar = (await this.listCalendarsForActor(input)).find(
      (candidate) => candidate.id === input.calendarId,
    );
    if (calendar === undefined) return null;

    const limit = Math.max(1, Math.min(input.limit ?? 250, 250));
    const rows = await this.sql<CalendarChangeRow[]>`
      select sync_version, event_id, deleted
      from cal_event_changes
      where org_id = ${input.orgId}
        and calendar_id = ${input.calendarId}
        and sync_version > ${input.afterVersion}
        and sync_version <= ${calendar.syncVersion}
      order by sync_version
      limit ${limit + 1}
    `;
    const pageRows = rows.slice(0, limit);
    const latestByEvent = new Map<string, CalendarChangeRow>();
    for (const row of pageRows) latestByEvent.set(row.event_id, row);
    const activeIds = [...latestByEvent.values()]
      .filter((row) => !row.deleted)
      .map((row) => row.event_id);
    const eventRows =
      activeIds.length === 0
        ? []
        : await this.sql<EventRow[]>`
            select * from cal_events
            where org_id = ${input.orgId}
              and calendar_id = ${input.calendarId}
              and id = any(${activeIds}::uuid[])
              and deleted_at is null
          `;
    const events = new Map(
      (await hydrateEvents(this.sql, eventRows)).map((event) => [event.id, event] as const),
    );
    const pageVersion = Number(pageRows.at(-1)?.sync_version ?? calendar.syncVersion);
    return {
      changes: [...latestByEvent.values()]
        .sort((left, right) => Number(left.sync_version) - Number(right.sync_version))
        .map((row) => ({
          version: Number(row.sync_version),
          eventId: row.event_id,
          event: row.deleted ? null : (events.get(row.event_id) ?? null),
        })),
      version: pageVersion,
      latestVersion: calendar.syncVersion,
      hasMore: rows.length > limit,
    };
  }

  async listCalendarFreeBusyEvents(
    input: CalendarFreeBusyRequest,
  ): Promise<readonly CalendarFreeBusyEvent[]> {
    const rows = await this.sql<
      {
        readonly event_id: string;
        readonly starts_at: Date;
        readonly ends_at: Date;
        readonly timezone: string;
        readonly all_day: boolean;
        readonly time_semantics: CalendarTimeSemantics;
        readonly starts_local: string;
        readonly status: CalendarEventStatus;
        readonly recurrence_rule: string | null;
        readonly metadata: JsonObject;
        readonly actor_id: string;
      }[]
    >`
      select e.id as event_id, e.starts_at, e.ends_at, e.timezone, e.all_day,
        e.time_semantics, e.starts_local, e.status, e.recurrence_rule, e.metadata, a.actor_id
      from cal_events e
      join cal_attendees a on a.event_id = e.id
      where e.org_id = ${input.orgId}
        and e.deleted_at is null
        and e.starts_at < ${input.endsAt}
        and (e.ends_at > ${input.startsAt} or e.recurrence_rule is not null)
        and a.response_status <> 'declined'
        and a.actor_id = any(${input.actorIds})
      order by e.starts_at
    `;
    return rows.map((row) => ({
      eventId: row.event_id,
      actorId: row.actor_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      allDay: row.all_day,
      timeSemantics: row.time_semantics,
      startsLocal: row.starts_local,
      status: row.status,
      transparency: calendarEventTransparency(row.metadata),
      recurrenceRule: row.recurrence_rule,
      metadata: row.metadata,
    }));
  }

  async getCalendarSearchRecord(eventId: string): Promise<CalendarSearchRecord | null> {
    const rows = await this.sql<EventRow[]>`
      select * from cal_events where id = ${eventId} limit 1
    `;
    return rows[0] === undefined
      ? null
      : mapCalendarSearchRecord(await hydrateEvent(this.sql, rows[0]));
  }

  async authenticateAppPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly requiredScope: string;
  }): Promise<Actor | null> {
    const rows = await this.sql<
      {
        readonly id: string;
        readonly org_id: string;
        readonly type: Actor["type"];
        readonly email: string | null;
        readonly display_name: string;
        readonly actor_scopes: readonly string[];
        readonly password_id: string;
        readonly hash: string;
        readonly password_scopes: readonly string[];
      }[]
    >`
      select a.id, a.org_id, a.type, a.email, a.display_name, a.scopes as actor_scopes, p.id as password_id, p.hash, p.scopes as password_scopes
      from app_passwords p
      join actors a on a.id = p.actor_id
      where p.revoked_at is null
        and (p.expires_at is null or p.expires_at > now())
        and a.disabled_at is null
        and (lower(a.email) = lower(${input.username}) or a.id::text = ${input.username})
    `;
    for (const row of rows) {
      const restrictedActor = restrictAppPasswordActor(
        {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          displayName: row.display_name,
          scopes: row.actor_scopes,
          ...(row.email === null ? {} : { email: row.email }),
        },
        row.password_scopes,
        { requiredScope: input.requiredScope, compatibilityScope: "caldav" },
      );
      if (restrictedActor === null) {
        continue;
      }
      if (await verifySecret(input.password, row.hash)) {
        await this.sql`update app_passwords set last_used_at = now() where id = ${row.password_id}`;
        return restrictedActor;
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
    const rows = await this.sql<CalendarMembershipRow[]>`
      with entries as (
        select
          c.id, c.org_id, c.name, c.description, c.timezone, c.color, c.sync_version,
          c.owner_actor_id,
          case
            when c.owner_actor_id = ${input.actorId} then 'owner'
            when m.role in ('owner', 'manager') then m.role::text
            when grant_row.role in ('owner', 'manager') then grant_row.role
            when m.role = 'writer' or grant_row.role in ('writer', 'editor') then 'writer'
            else 'reader'
          end as role,
          coalesce(m.visible, true) as visible,
          m.color_override,
          coalesce(m.sort_order, case when c.owner_actor_id = ${input.actorId} then 0 else 100 end) as sort_order
        from cal_calendars c
        left join cal_calendar_memberships m
          on m.calendar_id = c.id and m.actor_id = ${input.actorId}
        left join lateral (
          select permission.role
          from permissions permission
          where permission.org_id = ${input.orgId}
            and permission.actor_id = ${input.actorId}
            and permission.resource_type = 'calendar'
            and permission.resource_id = c.id
            and (permission.expires_at is null or permission.expires_at > now())
          order by case permission.role
            when 'owner' then 0 when 'manager' then 1 when 'writer' then 2
            when 'editor' then 3 else 4 end
          limit 1
        ) grant_row on true
        where c.org_id = ${input.orgId}
          and c.deleted_at is null
          and (
            c.owner_actor_id = ${input.actorId}
            or m.actor_id is not null
            or grant_row.role is not null
          )
      )
      select
        e.id, e.org_id, e.name, e.description, e.timezone, e.color, e.sync_version,
        e.owner_actor_id,
        e.color_override,
        e.visible,
        e.sort_order,
        e.role,
        a.display_name as owner_display_name,
        coalesce((
          select count(*)::int from cal_events ev
          where ev.calendar_id = e.id and ev.deleted_at is null
        ), 0) as event_count
      from entries e
      left join actors a on a.id = e.owner_actor_id
      order by e.sort_order asc, lower(e.name) asc
    `;
    return rows.map((row) => mapCalendarListEntry(row, input.actorId));
  }

  async listCalendarMemberships(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
  }): Promise<readonly CalendarMembershipRecord[] | null> {
    if (!(await hasCalendarManageAccess(this.sql, input.orgId, input.actorId, input.calendarId))) {
      return null;
    }
    const rows = await this.sql<CalendarMemberRow[]>`
      select
        membership.calendar_id,
        membership.actor_id,
        actor.display_name,
        actor.email,
        membership.role
      from cal_calendar_memberships membership
      join actors actor
        on actor.id = membership.actor_id
       and actor.org_id = membership.org_id
      where membership.org_id = ${input.orgId}
        and membership.calendar_id = ${input.calendarId}
        and actor.disabled_at is null
      order by
        case membership.role when 'owner' then 0 when 'manager' then 1 when 'writer' then 2 else 3 end,
        lower(coalesce(actor.display_name, actor.email, actor.id::text))
    `;
    return rows.map(mapCalendarMembership);
  }

  async setCalendarMembership(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly memberActorId: string;
    readonly role: Exclude<CalendarMembershipRole, "owner">;
  }): Promise<CalendarMembershipRecord | null> {
    return this.sql.begin(async (tx) => {
      if (!(await hasCalendarManageAccess(tx, input.orgId, input.actorId, input.calendarId))) {
        return null;
      }
      const rows = await tx<CalendarMemberRow[]>`
        insert into cal_calendar_memberships (org_id, calendar_id, actor_id, role)
        select ${input.orgId}, ${input.calendarId}, actor.id, ${input.role}::cal_membership_role
        from actors actor
        join orgs org on org.id = actor.org_id
        join cal_calendars calendar
          on calendar.id = ${input.calendarId}
         and calendar.org_id = ${input.orgId}
         and calendar.deleted_at is null
        where actor.id = ${input.memberActorId}
          and actor.org_id = ${input.orgId}
          and actor.disabled_at is null
          and org.status = 'active'
          and actor.id <> calendar.owner_actor_id
        on conflict (actor_id, calendar_id) do update
        set role = excluded.role, updated_at = now()
        returning
          calendar_id,
          actor_id,
          (select display_name from actors where id = actor_id and org_id = ${input.orgId}) as display_name,
          (select email from actors where id = actor_id and org_id = ${input.orgId}) as email,
          role
      `;
      const row = rows[0];
      if (row === undefined) return null;
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.membership.updated",
        input.calendarId,
        { memberActorId: input.memberActorId, role: input.role },
      );
      return mapCalendarMembership(row);
    });
  }

  async removeCalendarMembership(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly calendarId: string;
    readonly memberActorId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      if (!(await hasCalendarManageAccess(tx, input.orgId, input.actorId, input.calendarId))) {
        return false;
      }
      const rows = await tx<{ readonly actor_id: string }[]>`
        delete from cal_calendar_memberships membership
        using cal_calendars calendar
        where membership.org_id = ${input.orgId}
          and membership.calendar_id = ${input.calendarId}
          and membership.actor_id = ${input.memberActorId}
          and calendar.id = membership.calendar_id
          and calendar.org_id = membership.org_id
          and membership.actor_id <> calendar.owner_actor_id
        returning membership.actor_id
      `;
      if (rows[0] === undefined) return false;
      await appendCalendarActivity(
        tx,
        input.orgId,
        input.actorId,
        "calendar.membership.removed",
        input.calendarId,
        { memberActorId: input.memberActorId },
      );
      return true;
    });
  }
}

async function ensureDefaultCalendar(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  timezone: string,
): Promise<CalendarRecord> {
  const existing = await sql<CalendarRow[]>`
    select * from cal_calendars
    where org_id = ${orgId} and owner_actor_id = ${actorId} and deleted_at is null
    order by created_at
    limit 1
  `;
  if (existing[0] !== undefined) {
    return mapCalendar(existing[0]);
  }
  const rows = await sql<CalendarRow[]>`
    insert into cal_calendars (org_id, owner_actor_id, name, timezone)
    values (${orgId}, ${actorId}, 'Calendar', ${timezone})
    returning *
  `;
  return mapCalendar(rows[0]);
}

async function requireCalendarWriteAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string | null,
  calendarId: string,
): Promise<CalendarRecord> {
  const rows = await sql<CalendarRow[]>`
    select * from cal_calendars
    where id = ${calendarId}
      and org_id = ${orgId}
      and deleted_at is null
      and (
        owner_actor_id = ${actorId}
        or exists (
          select 1 from cal_calendar_memberships membership
          where membership.calendar_id = cal_calendars.id
            and membership.org_id = ${orgId}
            and membership.actor_id = ${actorId}
            and membership.role in ('owner', 'manager', 'writer')
        )
        or exists (
          select 1 from permissions p
          where p.resource_type = 'calendar'
            and p.resource_id = cal_calendars.id
            and p.org_id = ${orgId}
            and p.actor_id = ${actorId}
            and p.role in ('owner', 'writer', 'manager')
            and (p.expires_at is null or p.expires_at > now())
        )
      )
  `;
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
  action: "read" | "write" = "read",
  includeDeleted = false,
): Promise<CalendarEventRecord | null> {
  const rows = await sql<EventRow[]>`
    select e.*
    from cal_events e
    join cal_calendars c on c.id = e.calendar_id
    where e.id = ${eventId}
      and e.org_id = ${orgId}
      and (${includeDeleted} or e.deleted_at is null)
      and (
        c.owner_actor_id = ${actorId}
        or e.organizer_actor_id = ${actorId}
        or exists (
          select 1 from cal_calendar_memberships membership
          where membership.calendar_id = e.calendar_id
            and membership.org_id = ${orgId}
            and membership.actor_id = ${actorId}
            and (
              (${action} = 'read' and membership.role in ('owner', 'manager', 'writer', 'reader'))
              or (${action} = 'write' and membership.role in ('owner', 'manager'))
            )
        )
        or exists (
          select 1 from permissions p
          where p.resource_type = 'event'
            and p.resource_id = e.id
            and p.org_id = ${orgId}
            and p.actor_id = ${actorId}
            and p.role in ('owner', 'writer', 'manager')
            and (p.expires_at is null or p.expires_at > now())
        )
        or (
          ${action} = 'read'
          and (
            exists (
              select 1 from cal_attendees attendee
              where attendee.event_id = e.id and attendee.actor_id = ${actorId}
            )
            or exists (
              select 1 from cal_calendar_memberships membership
              where membership.calendar_id = e.calendar_id
                and membership.org_id = ${orgId}
                and membership.actor_id = ${actorId}
                and membership.role in ('owner', 'manager', 'writer', 'reader')
            )
            or exists (
              select 1 from permissions p
              where p.resource_type = 'event'
                and p.resource_id = e.id
                and p.org_id = ${orgId}
                and p.actor_id = ${actorId}
                and p.role in ('reader', 'viewer', 'participant')
                and (p.expires_at is null or p.expires_at > now())
            )
          )
        )
      )
    limit 1
  `;
  return rows[0] === undefined ? null : hydrateEvent(sql, rows[0]);
}

async function appendEventRevision(
  sql: SqlLike,
  eventId: string,
  changeKind: CalendarEventRevisionKind,
  changedByActorId: string | null,
): Promise<void> {
  await sql`
    insert into cal_event_revisions (
      org_id, event_id, revision, calendar_id, change_kind, changed_by_actor_id, snapshot
    )
    select event.org_id, event.id, event.ics_sequence, event.calendar_id, ${changeKind},
      ${changedByActorId},
      jsonb_build_object(
        'event', to_jsonb(event),
        'attendees', coalesce((
          select jsonb_agg(to_jsonb(attendee) order by attendee.is_organizer desc, attendee.email)
          from cal_attendees attendee
          where attendee.org_id = event.org_id and attendee.event_id = event.id
        ), '[]'::jsonb)
      )
    from cal_events event
    where event.id = ${eventId}
  `;
}

async function cancelResourceBookings(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  eventId: string,
): Promise<void> {
  await sql`
    update cal_resource_bookings set status = 'cancelled', decided_by_actor_id = ${actorId},
      decided_at = statement_timestamp(), updated_at = statement_timestamp()
    where org_id = ${orgId} and event_id = ${eventId} and status in ('pending', 'approved')
  `;
}

async function hasCalendarManageAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  calendarId: string,
): Promise<boolean> {
  const rows = await sql<{ readonly id: string }[]>`
    select calendar.id
    from cal_calendars calendar
    where calendar.id = ${calendarId}
      and calendar.org_id = ${orgId}
      and calendar.deleted_at is null
      and (
        calendar.owner_actor_id = ${actorId}
        or exists (
          select 1 from cal_calendar_memberships membership
          where membership.calendar_id = calendar.id
            and membership.org_id = ${orgId}
            and membership.actor_id = ${actorId}
            and membership.role in ('owner', 'manager')
        )
        or exists (
          select 1 from permissions permission
          where permission.resource_type = 'calendar'
            and permission.resource_id = calendar.id
            and permission.org_id = ${orgId}
            and permission.actor_id = ${actorId}
            and permission.role in ('owner', 'manager')
            and (permission.expires_at is null or permission.expires_at > now())
        )
      )
    for update
  `;
  return rows[0] !== undefined;
}

async function selectEventById(
  sql: SqlLike,
  orgId: string,
  eventId: string,
): Promise<CalendarEventRecord | null> {
  const rows = await sql<EventRow[]>`
    select * from cal_events where id = ${eventId} and org_id = ${orgId} limit 1
  `;
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
  if (rows.length === 0) return [];
  const attendeeRows = await sql<AttendeeRow[]>`
    select * from cal_attendees
    where event_id = any(${rows.map((row) => row.id)}::uuid[])
    order by event_id, is_organizer desc, email
  `;
  const attendeesByEvent = new Map<string, CalendarAttendeeRecord[]>();
  for (const attendee of attendeeRows) {
    const attendees = attendeesByEvent.get(attendee.event_id) ?? [];
    attendees.push(mapAttendee(attendee));
    attendeesByEvent.set(attendee.event_id, attendees);
  }
  return rows.map((row) => mapEvent(row, attendeesByEvent.get(row.id) ?? []));
}

async function hydrateEvent(sql: SqlLike, row: EventRow): Promise<CalendarEventRecord> {
  const attendeeRows = await sql<AttendeeRow[]>`
    select * from cal_attendees where event_id = ${row.id} order by is_organizer desc, email
  `;
  return mapEvent(row, attendeeRows.map(mapAttendee));
}

async function syncAttendees(
  sql: SqlLike,
  event: CalendarEventRecord,
  actorId: string,
  organizerEmail: string | null,
  attendees: readonly CalendarAttendeeInput[],
): Promise<void> {
  const canonical = await resolveCalendarAttendees(sql, event.orgId, attendees);
  const normalized = new Map<string, CalendarAttendeeInput>();
  for (const attendee of canonical) {
    normalized.set(attendee.email.toLowerCase(), attendee);
  }
  if (organizerEmail !== null) {
    normalized.set(organizerEmail.toLowerCase(), {
      actorId,
      email: organizerEmail,
      displayName: null,
      role: "required",
      responseStatus: "accepted",
    });
  }
  const existing = await sql<AttendeeRow[]>`
    select * from cal_attendees where org_id = ${event.orgId} and event_id = ${event.id}
  `;
  const unmatched = new Map(existing.map((attendee) => [attendee.id, attendee]));
  for (const attendee of normalized.values()) {
    const isOrganizer =
      attendee.actorId === actorId ||
      (organizerEmail !== null && attendee.email.toLowerCase() === organizerEmail.toLowerCase());
    const current = existing.find(
      (candidate) =>
        (attendee.actorId !== undefined &&
          attendee.actorId !== null &&
          candidate.actor_id === attendee.actorId) ||
        candidate.email.toLowerCase() === attendee.email.toLowerCase(),
    );
    if (current === undefined) {
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
    } else {
      unmatched.delete(current.id);
      await sql`
        update cal_attendees
        set actor_id = ${attendee.actorId ?? null},
            email = ${attendee.email},
            display_name = ${attendee.displayName ?? null},
            role = ${attendee.role ?? "required"},
            response_status = ${isOrganizer ? "accepted" : current.response_status},
            is_organizer = ${isOrganizer},
            metadata = ${sql.json(toSqlJson({ ...current.metadata, ...(attendee.metadata ?? {}) }))},
            updated_at = now()
        where id = ${current.id} and org_id = ${event.orgId} and event_id = ${event.id}
      `;
    }
    if (
      attendee.actorId !== undefined &&
      attendee.actorId !== null &&
      current?.actor_id !== attendee.actorId
    ) {
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
  for (const removed of unmatched.values()) {
    if (removed.actor_id !== null) {
      await sql`
        delete from permissions
        where org_id = ${event.orgId}
          and actor_id = ${removed.actor_id}
          and resource_type = 'event'
          and resource_id = ${event.id}
          and role = 'participant'
      `;
    }
    await sql`
      delete from cal_attendees
      where id = ${removed.id} and org_id = ${event.orgId} and event_id = ${event.id}
    `;
  }
}

interface CalendarIdentityRow {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string;
  readonly disabled_at: Date | null;
}

async function resolveCalendarAttendees(
  sql: SqlLike,
  orgId: string,
  attendees: readonly CalendarAttendeeInput[],
): Promise<readonly CalendarAttendeeInput[]> {
  if (attendees.length === 0) {
    return [];
  }
  const actorIds = [...new Set(attendees.flatMap((attendee) => attendee.actorId ?? []))];
  const emails = [...new Set(attendees.map((attendee) => attendee.email.trim().toLowerCase()))];
  const rows = await sql<CalendarIdentityRow[]>`
    select actor.id, actor.email, actor.display_name, actor.disabled_at
    from actors actor
    join orgs org on org.id = actor.org_id and org.status = 'active'
    where actor.org_id = ${orgId}
      and (
        actor.id = any(${sql.array(actorIds)}::uuid[])
        or lower(actor.email) = any(${sql.array(emails)}::text[])
      )
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byEmail = new Map(
    rows.flatMap((row) => (row.email === null ? [] : [[row.email.toLowerCase(), row] as const])),
  );
  return attendees.map((attendee) => {
    const email = attendee.email.trim().toLowerCase();
    const identity = attendee.actorId == null ? byEmail.get(email) : byId.get(attendee.actorId);
    if (identity !== undefined && identity.disabled_at !== null) {
      throw new Error(`Calendar attendee is disabled: ${email}`);
    }
    if (attendee.actorId != null && identity === undefined) {
      throw new Error(
        `Calendar attendee actor is not active in this organization: ${attendee.actorId}`,
      );
    }
    if (
      attendee.actorId != null &&
      (identity?.email === null || identity?.email.toLowerCase() !== email)
    ) {
      throw new Error(`Calendar attendee email does not match actor: ${attendee.actorId}`);
    }
    if (identity === undefined) {
      return { ...attendee, actorId: null, email };
    }
    if (identity.email === null) {
      throw new Error(`Calendar attendee actor has no verified address: ${identity.id}`);
    }
    return {
      ...attendee,
      actorId: identity.id,
      email: identity.email.toLowerCase(),
      displayName: identity.display_name,
    };
  });
}

async function requireActiveCalendarActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): Promise<{ readonly email: string }> {
  const rows = await sql<{ readonly email: string | null }[]>`
    select actor.email
    from actors actor
    join orgs org on org.id = actor.org_id and org.status = 'active'
    where actor.id = ${actorId}
      and actor.org_id = ${orgId}
      and actor.type = 'user'
      and actor.disabled_at is null
      and actor.email is not null
    limit 1
  `;
  const email = rows[0]?.email;
  if (email === null || email === undefined) {
    throw new Error(
      "Calendar organizer must be an active user with a verified organization address.",
    );
  }
  return { email: email.toLowerCase() };
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
    select ${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${grantedByActorId}
    where not exists (
      select 1 from permissions
      where org_id = ${orgId}
        and actor_id = ${actorId}
        and resource_type = ${resourceType}
        and resource_id = ${resourceId}
        and role = ${role}
        and status = 'active'
        and revoked_at is null
        and valid_from <= statement_timestamp()
        and (expires_at is null or expires_at > statement_timestamp())
    )
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
  const previousRows = await sql<{ readonly this_hash: string }[]>`
    select this_hash from activity where org_id = ${orgId} order by created_at desc limit 1
  `;
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
  if (
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(endsAt.getTime()) ||
    endsAt.getTime() <= startsAt.getTime()
  ) {
    throw new Error("Calendar event end must be after start.");
  }
}

function validateSchedulingMetadata(metadata: JsonObject | undefined): void {
  if (metadata === undefined) return;
  const eventType = metadata.eventType;
  if (
    eventType !== undefined &&
    eventType !== "default" &&
    eventType !== "focus" &&
    eventType !== "out_of_office" &&
    eventType !== "holiday"
  ) {
    throw new Error("Calendar eventType must be default, focus, out_of_office, or holiday.");
  }
  const transparency = metadata.transparency;
  if (transparency !== undefined && transparency !== "opaque" && transparency !== "transparent") {
    throw new Error("Calendar transparency must be opaque or transparent.");
  }
}

function calendarEventTransparency(metadata: JsonObject): "opaque" | "transparent" {
  return metadata.transparency === "transparent" ? "transparent" : "opaque";
}

function resolveCalendarEventTime(input: {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly allDay: boolean;
  readonly timeSemantics?: CalendarTimeSemantics | undefined;
}) {
  validateTimeRange(input.startsAt, input.endsAt);
  const timeSemantics = input.allDay ? "all_day" : (input.timeSemantics ?? "zoned");
  if ((timeSemantics === "all_day") !== input.allDay) {
    throw new Error("All-day events require all_day time semantics.");
  }
  const timezone = canonicalTimeZone(input.timezone);
  const intentZone = timeSemantics === "zoned" ? timezone : "UTC";
  const startsLocal = instantToLocalDateTime(input.startsAt, intentZone);
  const endsLocal = instantToLocalDateTime(input.endsAt, intentZone);
  if (
    timeSemantics === "all_day" &&
    (!startsLocal.endsWith("T00:00:00") || !endsLocal.endsWith("T00:00:00"))
  ) {
    throw new Error("All-day events require date-boundary instants.");
  }
  return {
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    timezone,
    allDay: input.allDay,
    timeSemantics,
    startsLocal,
    endsLocal,
  };
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
    syncVersion: Number(row.sync_version),
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
    syncVersion: Number(row.sync_version),
  };
}

function mapCalendarMembership(row: CalendarMemberRow): CalendarMembershipRecord {
  return {
    calendarId: row.calendar_id,
    actorId: row.actor_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
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
    timeSemantics: row.time_semantics,
    startsLocal: row.starts_local,
    endsLocal: row.ends_local,
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

function mapEventRevision(row: EventRevisionRow): CalendarEventRevisionRecord {
  return {
    eventId: row.event_id,
    revision: row.revision,
    calendarId: row.calendar_id,
    changeKind: row.change_kind,
    changedByActorId: row.changed_by_actor_id,
    snapshot: row.snapshot,
    createdAt: row.created_at,
  };
}

function mapCalendarSearchRecord(event: CalendarEventRecord): CalendarSearchRecord {
  const visibility = calendarVisibility(event.metadata.visibility);
  const classification = calendarClassification(
    sensitivityClassificationFromMetadata(event.metadata),
  );
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
