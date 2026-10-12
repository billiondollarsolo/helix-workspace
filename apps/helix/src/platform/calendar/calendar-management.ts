import type postgres from "postgres";
import { ensureDefaultCalendar, mapCalendar, type CalendarRow } from "./calendar-records.js";
import { appendCalendarActivity, grantAccess, hasCalendarManageAccess } from "./store-access.js";
import type { CalendarRecord } from "./types.js";

export interface CreateCalendarInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly color: string;
}

export interface UpdateCalendarInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly calendarId: string;
  readonly name?: string | undefined;
  readonly color?: string | undefined;
}

export interface DeleteCalendarInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly calendarId: string;
}

export function createCalendar(
  sql: postgres.Sql,
  input: CreateCalendarInput,
): Promise<CalendarRecord> {
  return sql.begin(async (tx) => {
    // The default calendar must exist first: it is defined as the oldest one the actor owns.
    await ensureDefaultCalendar(tx, input.orgId, input.actorId, "UTC");
    const rows = await tx<CalendarRow[]>`
      insert into cal_calendars (org_id, owner_actor_id, name, color, timezone)
      select ${input.orgId}, actor.id, ${input.name}, ${input.color},
        (select calendar.timezone from cal_calendars calendar
          where calendar.org_id = actor.org_id and calendar.owner_actor_id = actor.id
            and calendar.deleted_at is null
          order by calendar.created_at limit 1)
      from actors actor
      where actor.id = ${input.actorId} and actor.org_id = ${input.orgId}
        and actor.disabled_at is null
      returning *
    `;
    const calendar = mapCalendar(rows[0]);
    await tx`
      insert into cal_calendar_memberships (org_id, calendar_id, actor_id, role, sort_order)
      values (${input.orgId}, ${calendar.id}, ${input.actorId}, 'owner', 10)
      on conflict (actor_id, calendar_id) do nothing
    `;
    await grantAccess(
      tx,
      input.orgId,
      input.actorId,
      "calendar",
      calendar.id,
      "owner",
      input.actorId,
    );
    await appendCalendarActivity(
      tx,
      input.orgId,
      input.actorId,
      "calendar.calendar.created",
      calendar.id,
      { name: input.name },
    );
    return calendar;
  });
}

export function updateCalendar(
  sql: postgres.Sql,
  input: UpdateCalendarInput,
): Promise<CalendarRecord | null> {
  return sql.begin(async (tx) => {
    if (!(await hasCalendarManageAccess(tx, input.orgId, input.actorId, input.calendarId))) {
      return null;
    }
    const rows = await tx<CalendarRow[]>`
      update cal_calendars
      set name = coalesce(${input.name ?? null}, name),
          color = coalesce(${input.color ?? null}, color),
          updated_at = now()
      where id = ${input.calendarId} and org_id = ${input.orgId}
      returning *
    `;
    const calendar = mapCalendar(rows[0]);
    // A colour the actor overrode for themselves would hide the change they just made.
    if (input.color !== undefined) {
      await tx`
        update cal_calendar_memberships set color_override = null
        where calendar_id = ${input.calendarId} and org_id = ${input.orgId}
          and actor_id = ${input.actorId}
      `;
    }
    await appendCalendarActivity(
      tx,
      input.orgId,
      input.actorId,
      "calendar.calendar.updated",
      calendar.id,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.color === undefined ? {} : { color: input.color }),
      },
    );
    return calendar;
  });
}

/** Soft-deletes a calendar and its events; the owner's default calendar is never deletable. */
export function deleteCalendar(sql: postgres.Sql, input: DeleteCalendarInput): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${`calendar-default:${input.orgId}:${input.actorId}`}, 0)
      )
    `;
    const owned = await tx<{ readonly id: string }[]>`
      select id from cal_calendars
      where org_id = ${input.orgId} and owner_actor_id = ${input.actorId} and deleted_at is null
      order by created_at
      for update
    `;
    // Index 0 is the default calendar; -1 means the actor does not own it.
    if (owned.findIndex((row) => row.id === input.calendarId) < 1) return false;
    await tx`
      update cal_events set deleted_at = now(), updated_at = now()
      where calendar_id = ${input.calendarId} and org_id = ${input.orgId} and deleted_at is null
    `;
    await tx`
      update cal_calendars set deleted_at = now(), updated_at = now()
      where id = ${input.calendarId} and org_id = ${input.orgId}
    `;
    await appendCalendarActivity(
      tx,
      input.orgId,
      input.actorId,
      "calendar.calendar.deleted",
      input.calendarId,
      {},
    );
    return true;
  });
}
