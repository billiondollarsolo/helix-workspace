import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { activityChainHash } from "../activity/hash-chain.js";
import { toSqlJson } from "../util/sql.js";

type SqlLike = postgres.Sql | postgres.TransactionSql;

export async function grantAccess(
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

export async function appendCalendarActivity(
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

export async function hasCalendarManageAccess(
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
