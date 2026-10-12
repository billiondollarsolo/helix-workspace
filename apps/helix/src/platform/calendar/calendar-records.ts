import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import type { CalendarRecord } from "./types.js";

export interface CalendarRow {
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

export function mapCalendar(row: CalendarRow | undefined): CalendarRecord {
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

/**
 * The owner's primary calendar, created on first use and named after them.
 * Runs inside the caller's transaction; the lock makes concurrent first events
 * for one person share a single calendar instead of each creating one.
 */
export async function ensureDefaultCalendar(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
  actorId: string,
  timezone: string,
): Promise<CalendarRecord> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${`calendar-default:${orgId}:${actorId}`}, 0))
  `;
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
    values (
      ${orgId},
      ${actorId},
      coalesce(
        (
          select coalesce(nullif(btrim(actor.display_name), ''), actor.email)
          from actors actor
          where actor.org_id = ${orgId} and actor.id = ${actorId}
        ),
        'Calendar'
      ),
      ${timezone}
    )
    returning *
  `;
  return mapCalendar(rows[0]);
}
