import type { JsonObject } from "@helix/sdk-types";
import { toSqlJson } from "../../util/sql.js";
import { type SqlLike } from "./rows.js";
export async function appendDriveActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  // The database serializes and hashes the append-only audit chain.
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash, created_at)
    values (${input.orgId}, ${input.actorId}, ${input.verb}, 'drive.object', ${input.objectId}, ${sql.json(toSqlJson(input.payload))}, null, '', now())
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        objectId: input.objectId,
        ...input.payload,
      }),
    )})
  `;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
