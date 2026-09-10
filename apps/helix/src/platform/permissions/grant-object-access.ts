import type postgres from "postgres";

/** A `postgres` client or an open transaction — either can run the insert. */
type SqlLike = postgres.Sql | postgres.TransactionSql;

/**
 * Grant an actor a role on a Drive {@link objects} row.
 *
 * Drive object owners use one permission representation.
 * The insert is idempotent (`on conflict do nothing`).
 */
export async function grantObjectAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'object', ${input.objectId}, ${input.role}, ${input.grantedByActorId})
    on conflict do nothing
  `;
}
