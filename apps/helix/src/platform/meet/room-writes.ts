import type { JsonObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";

export type SqlLike = postgres.Sql | postgres.TransactionSql;

/** Append a Meet room event to the tenant activity log. */
export async function appendMeetActivity(
  sql: SqlLike,
  orgId: string,
  actorId: string | null,
  verb: string,
  roomId: string,
  payload: JsonObject,
): Promise<void> {
  const hash = createHash("sha256")
    .update(`${orgId}:${actorId ?? "system"}:${verb}:${roomId}:${String(Date.now())}`)
    .digest("hex");
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (${orgId}, ${actorId}, ${verb}, 'meet_room', ${roomId}, ${sql.json(toSqlJson(payload))}, null, ${hash})
  `;
}

/** Grant an actor a role on a room's call thread. */
export async function grantThreadAccess(
  sql: SqlLike,
  orgId: string,
  threadId: string,
  actorId: string,
  role: string,
  grantedByActorId: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, 'thread', ${threadId}, ${role}, ${grantedByActorId})
    on conflict do nothing
  `;
}

/** Grant an actor a role on a Meet room. */
export async function grantMeetAccess(
  sql: SqlLike,
  orgId: string,
  roomId: string,
  actorId: string,
  role: string,
  grantedByActorId: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, 'meet_room', ${roomId}, ${role}, ${grantedByActorId})
    on conflict do nothing
  `;
}
